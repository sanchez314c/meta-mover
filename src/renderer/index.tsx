/**
 * React Application Entry Point
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';

import App from './App';
import { store } from './store';
import { GlobalStyles } from './styles/GlobalStyles';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

const root = createRoot(container);

root.render(
  <Provider store={store}>
    <GlobalStyles />
    <App />
  </Provider>
);
