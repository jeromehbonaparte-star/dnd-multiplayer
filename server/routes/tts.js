/**
 * TTS (Text-to-Speech) Routes
 * Handles text-to-speech audio generation using OpenAI TTS API
 */

const express = require('express');

/**
 * Split text into TTS-friendly chunks
 * @param {string} text - Text to split
 * @param {number} maxLength - Maximum chunk length
 * @returns {Array<string>} Array of text chunks
 */
function splitTextForTTS(text, maxLength = 4000) {
  if (!text || text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  // Split by sentences first
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];

  let currentChunk = '';

  for (const sentence of sentences) {
    // If single sentence is too long, split by commas
    if (sentence.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      // Split long sentence by commas/semicolons
      const clauses = sentence.split(/(?<=[,;])\s*/);
      for (const clause of clauses) {
        if ((currentChunk + clause).length > maxLength) {
          if (currentChunk) chunks.push(currentChunk.trim());
          currentChunk = clause;
        } else {
          currentChunk += clause;
        }
      }
    } else if ((currentChunk + sentence).length > maxLength) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Create TTS router with dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.auth - Auth middleware
 * @param {Function} deps.getOpenAIApiKey - Function to get OpenAI API key
 * @returns {express.Router}
 */
function createTTSRoutes(deps) {
  const { db, auth, getOpenAIApiKey } = deps;
  const router = express.Router();
  const { checkPassword } = auth;

  /**
   * POST /api/tts/info
   * Get TTS metadata (chunk count and info)
   */
  router.post('/info', checkPassword, (req, res) => {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const chunks = splitTextForTTS(text);

    res.json({
      totalChunks: chunks.length,
      totalLength: text.length,
      chunks: chunks.map((c, i) => ({
        index: i,
        length: c.length,
        preview: c.substring(0, 50) + (c.length > 50 ? '...' : '')
      }))
    });
  });

  /**
   * POST /api/tts/audio
   * Generate TTS audio for a chunk
   */
  router.post('/audio', checkPassword, async (req, res) => {
    const { text, chunkIndex = 0, voice = 'alloy', speed = 1.0 } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Get API key
    const ttsApiKey = process.env.OPENAI_TTS_API_KEY || getOpenAIApiKey();

    if (!ttsApiKey) {
      return res.status(400).json({
        error: 'No OpenAI API key configured for TTS. Add OPENAI_TTS_API_KEY to environment or configure an OpenAI API in settings.'
      });
    }

    const chunks = splitTextForTTS(text);
    const chunk = chunks[parseInt(chunkIndex)];

    if (!chunk) {
      return res.status(404).json({ error: 'Chunk not found' });
    }

    try {
      console.log(`TTS Request: chunk ${chunkIndex + 1}/${chunks.length}, ${chunk.length} chars, voice: ${voice}, speed: ${speed}`);

      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ttsApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: chunk,
          voice: voice,
          speed: parseFloat(speed) || 1.0,
          response_format: 'mp3'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('TTS API error:', errorText);
        return res.status(response.status).json({ error: `TTS API error: ${errorText}` });
      }

      // Stream the audio response
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': buffer.length
      });
      res.send(buffer);

    } catch (error) {
      console.error('TTS error:', error);
      res.status(500).json({ error: `TTS generation failed: ${error.message}` });
    }
  });

  return router;
}

module.exports = { createTTSRoutes, splitTextForTTS };
