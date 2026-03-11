// ============================================
// Character Edit Modal (AI-guided)
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml, formatChatMessage } from '../../utils/formatters.js';
import { showNotification } from '../../utils/dom.js';
import { loadCharacters } from '../characters.js';
import { refreshSessionCharacters } from '../sessions.js';

export function openEditModal(charId) {
  const characters = getState('characters');
  setState({ modalCharacterId: charId, modalMessages: [], modalMode: 'edit' });

  const char = characters.find(c => c.id === charId);
  document.getElementById('modal-title').textContent = `Edit ${char.character_name}`;
  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant">
      <div class="message-content">What would you like to change about ${char.character_name}? You can ask me to update stats, spells, skills, appearance, backstory, or anything else. (Use the Inventory button to manage items.)</div>
    </div>
  `;
  document.getElementById('modal-input').value = '';
  document.getElementById('char-modal').classList.add('active');
}

export function closeModal() {
  document.getElementById('char-modal').classList.remove('active');
  setState({
    modalCharacterId: null,
    modalMessages: [],
    levelUpModalCharId: null,
    levelUpMessages: []
  });
}

export async function sendModalMessage() {
  const input = document.getElementById('modal-input');
  const message = input.value.trim();

  const levelUpModalCharId = getState('levelUpModalCharId');
  const modalCharacterId = getState('modalCharacterId');
  const isLevelUp = levelUpModalCharId !== null;
  const charId = isLevelUp ? levelUpModalCharId : modalCharacterId;

  if (!message || !charId) return;

  input.value = '';
  const messagesContainer = document.getElementById('modal-chat-messages');

  messagesContainer.innerHTML += `<div class="chat-message user"><div class="message-content">${escapeHtml(message)}</div></div>`;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  if (isLevelUp) {
    const msgs = [...getState('levelUpMessages'), { role: 'user', content: message }];
    setState({ levelUpMessages: msgs });
  } else {
    const msgs = [...getState('modalMessages'), { role: 'user', content: message }];
    setState({ modalMessages: msgs });
  }

  messagesContainer.innerHTML += '<div class="chat-message assistant" id="modal-loading"><div class="message-content">Thinking...</div></div>';
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    let result;
    if (isLevelUp) {
      const levelUpMessages = getState('levelUpMessages');
      result = await api(`/api/characters/${charId}/levelup`, 'POST', { messages: levelUpMessages });
      setState({ levelUpMessages: [...levelUpMessages, { role: 'assistant', content: result.message }] });
    } else {
      const modalMessages = getState('modalMessages');
      result = await api(`/api/characters/${charId}/edit`, 'POST', {
        editRequest: modalMessages.length === 1 ? message : undefined,
        messages: modalMessages
      });
      setState({ modalMessages: [...modalMessages, { role: 'assistant', content: result.message }] });
    }

    document.getElementById('modal-loading')?.remove();

    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (result.complete) {
      loadCharacters();
      await refreshSessionCharacters();
      if (isLevelUp) {
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Level up complete!</strong></div></div>`;
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Want to make any other changes? Just ask!</div></div>`;
        showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
        setState({ levelUpMessages: [] });
      } else {
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Changes saved!</strong></div></div>`;
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Want to make more changes? Just ask!</div></div>`;
        setState({ modalMessages: [] });
      }
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  } catch (error) {
    document.getElementById('modal-loading')?.remove();
    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Error: ${error.message}</div></div>`;
  }
}
