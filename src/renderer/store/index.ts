/**
 * Redux Store Configuration
 *
 * Configures the Redux store with Redux Toolkit including
 * middleware, dev tools, and state persistence
 */

import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit';

import appSlice from './slices/appSlice';
import jobsSlice from './slices/jobsSlice';
import settingsSlice from './slices/settingsSlice';
import uiSlice from './slices/uiSlice';

// Create listener middleware for side effects
const listenerMiddleware = createListenerMiddleware();

export const store = configureStore({
  reducer: {
    app: appSlice.reducer,
    jobs: jobsSlice,
    settings: settingsSlice,
    ui: uiSlice,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // Ignore these action types
        ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
        // Ignore these field paths in all actions
        ignoredActionPaths: ['meta.arg', 'payload.timestamp'],
        // Ignore these paths in the state
        ignoredPaths: ['items.dates'],
      },
    }).concat(listenerMiddleware.middleware),
  devTools: process.env.NODE_ENV !== 'production',
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Export action creators and selectors
export { default as appSlice } from './slices/appSlice';
export { default as jobsSlice } from './slices/jobsSlice';
export { default as settingsSlice } from './slices/settingsSlice';
export { default as uiSlice } from './slices/uiSlice';
