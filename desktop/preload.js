'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('pilot', {
  nav: (action, url) => ipcRenderer.invoke('nav', action, url),
  readPage: () => ipcRenderer.invoke('page:read'),
  capturePage: (target) => ipcRenderer.invoke('page:capture', target),
  ocrLoop: () => ipcRenderer.invoke('page:ocrLoop'),
  fetchExam: () => ipcRenderer.invoke('page:fetchExam'),
  execute: (payload) => ipcRenderer.invoke('page:execute', payload),
  saveDraft: () => ipcRenderer.invoke('page:save'),
  exportAnswers: (payload) => ipcRenderer.invoke('answers:export', payload),
  stop: () => ipcRenderer.invoke('page:stop'),
  serverCheck: () => ipcRenderer.invoke('server:check'),
  setServer: (url) => ipcRenderer.invoke('server:set', url),
  settings: () => ipcRenderer.invoke('backend:settings'),
  models: () => ipcRenderer.invoke('backend:models'),
  writeLog: (scope, text) => ipcRenderer.send('log:write', { scope, text }),
  logPath: () => ipcRenderer.invoke('log:path'),
  updateSettings: (patch) => ipcRenderer.invoke('backend:settingsUpdate', patch),
  runs: () => ipcRenderer.invoke('backend:runs'),
  testAi: () => ipcRenderer.invoke('backend:aiTest'),
  quiz: (payload) => ipcRenderer.invoke('ai:quiz', payload),
  ocr: (payload) => ipcRenderer.invoke('backend:ocr', payload),
  onBrowserState: subscribe('browser:state'),
  onBrowserNotice: subscribe('browser:notice'),
  onRunEvent: subscribe('run:event'),
  onServerState: subscribe('server:state'),
});
