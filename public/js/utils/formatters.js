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
  allEls.forEach(el => {
    // Strip ALL on* event handler attributes (covers onerror, onwheel, onpointerenter, etc.)
    const attrs = [...el.attributes];
    for (const attr of attrs) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
    // Remove javascript: and data: protocols from href/src
    ['href', 'src', 'action'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (val) {
        const trimmed = val.trim().toLowerCase();
        if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) {
          el.removeAttribute(attr);
        }
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
  if (!content) return '';
  // Check if content contains HTML tags
  const hasHtml = /<[a-z][\s\S]*?>/i.test(content);

  if (hasHtml) {
    // HTML mode: sanitize and pass through
    let html = sanitizeHtml(content);
    // Convert newlines to <br> only in text segments (outside HTML tags)
    html = html.replace(/(^|>)([^<]+)(<|$)/g, (match, before, text, after) => {
      const converted = text
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');
      return before + converted + after;
    });
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
