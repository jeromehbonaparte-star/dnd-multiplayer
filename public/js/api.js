// ============================================
// API Fetch Wrapper
// ============================================

import { setState } from './state.js';

export async function api(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, options);

  if (response.status === 401) {
    setState({ currentUser: null });
    throw new Error('Authentication required');
  }

  // 403 falls through to the structured error path below so callers see the
  // server's reason ("It is not that character's turn.") instead of "Forbidden".

  // Check content type before parsing
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    console.error('Non-JSON response:', response.status, text.substring(0, 200));
    throw new Error(`Server error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!response.ok) {
    // Keep the status and the parsed body on the error so callers can react to
    // structured failures (409 unresolved_class, 400 with suggestions, ...).
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
