// ============================================
// Text Formatting Utilities
// ============================================

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Sanitize HTML: allow safe tags, strip scripts and dangerous attributes.
 */
function sanitizeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all script, iframe, object, embed, form elements
  const dangerous = doc.querySelectorAll('script, iframe, object, embed, form, link, meta, base');
  dangerous.forEach(el => el.remove());

  // Remove dangerous attributes from all remaining elements
  const allEls = doc.body.querySelectorAll('*');
  const dangerousAttrs = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus',
    'onblur', 'oninput', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress'];
  allEls.forEach(el => {
    dangerousAttrs.forEach(attr => el.removeAttribute(attr));
    // Remove javascript: protocol from href/src
    ['href', 'src', 'action'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (val && val.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr);
      }
    });
  });

  return doc.body.innerHTML;
}

/**
 * Format AI narration content — supports HTML passthrough with sanitization,
 * plus markdown bold/italic for non-HTML content.
 */
export function formatContent(content) {
  // Check if content contains HTML tags
  const hasHtml = /<[a-z][\s\S]*?>/i.test(content);

  if (hasHtml) {
    // HTML mode: sanitize and pass through, convert remaining markdown
    let html = sanitizeHtml(content);
    // Convert markdown bold/italic that may exist alongside HTML
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    return html;
  }

  // Plain text mode: escape HTML, convert newlines and markdown
  return escapeHtml(content)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

export function formatChatMessage(text) {
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}
