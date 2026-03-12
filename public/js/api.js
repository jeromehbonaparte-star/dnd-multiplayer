// ============================================
// API Fetch Wrapper
// ============================================

import { getState, setState } from './state.js';

export async function api(endpoint, method = 'GET', body = null) {
  const { adminPassword } = getState();

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  // Add admin password header if authenticated
  if (adminPassword) {
    options.headers['X-Admin-Password'] = adminPassword;
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, options);

  if (response.status === 403) {
    setState({ isAdminAuthenticated: false, adminPassword: '' });
    throw new Error('Admin access required');
  }

  // Check content type before parsing
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    console.error('Non-JSON response:', response.status, text.substring(0, 200));
    throw new Error(`Server error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}
