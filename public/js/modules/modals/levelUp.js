// ============================================
// Level Up Modal
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml, formatChatMessage } from '../../utils/formatters.js';
import { showNotification } from '../../utils/dom.js';
import { getRequiredXP, canLevelUp } from '../../utils/gameRules.js';
import { loadCharacters } from '../characters.js';

export function levelUpCharacter(charId) {
  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  const canLevel = canLevelUp(char.xp || 0, char.level);
  if (!canLevel) {
    alert(`${char.character_name} needs ${getRequiredXP(char.level)} XP to level up. Current: ${char.xp || 0} XP`);
    return;
  }

  openLevelUpModal(charId);
}

function openLevelUpModal(charId) {
  setState({ levelUpModalCharId: charId, levelUpMessages: [] });

  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  document.getElementById('modal-title').textContent = `Level Up ${char.character_name} to Level ${char.level + 1}`;
  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant">
      <div class="message-content">Starting level up process...</div>
    </div>
  `;
  document.getElementById('modal-input').value = '';
  document.getElementById('char-modal').classList.add('active');

  startLevelUpConversation(charId);
}

async function startLevelUpConversation(charId) {
  const msgs = [{ role: 'user', content: 'I want to level up my character. Please guide me through the process.' }];
  setState({ levelUpMessages: msgs });

  try {
    const result = await api(`/api/characters/${charId}/levelup`, 'POST', { messages: msgs });
    setState({ levelUpMessages: [...msgs, { role: 'assistant', content: result.message }] });

    const messagesContainer = document.getElementById('modal-chat-messages');
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (result.complete) {
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Level up complete!</strong></div></div>`;
      loadCharacters();
      showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
    }
  } catch (error) {
    const messagesContainer = document.getElementById('modal-chat-messages');
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(error.message)}</div></div>`;
  }
}
