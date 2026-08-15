const { contextBridge, ipcRenderer } = require('electron');

// The renderer never touches Supabase or Node directly -- every
// action goes through here as a narrow, named call. Nothing beyond
// this list is reachable from the page.
contextBridge.exposeInMainWorld('nestrAPI', {
  login: (companyCode, employeeId, pin, location) =>
    ipcRenderer.invoke('nestr:login', { companyCode, employeeId, pin, location }),
  logout: () => ipcRenderer.invoke('nestr:logout'),
  getSession: () => ipcRenderer.invoke('nestr:get-session'),

  getPunchState: () => ipcRenderer.invoke('nestr:get-punch-state'),
  breakStart: (location) => ipcRenderer.invoke('nestr:break-start', location),
  breakEnd: (location) => ipcRenderer.invoke('nestr:break-end', location),
  checkIn: (location) => ipcRenderer.invoke('nestr:check-in', location),
  checkOut: (location) => ipcRenderer.invoke('nestr:check-out', location),
  getShiftInfo: () => ipcRenderer.invoke('nestr:get-shift-info'),

  getTheme: () => ipcRenderer.invoke('nestr:get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('nestr:set-theme', theme),

  getConversations: () => ipcRenderer.invoke('nestr:get-conversations'),
  searchPeople: (query) => ipcRenderer.invoke('nestr:search-people', query),
  getThread: (id) => ipcRenderer.invoke('nestr:get-thread', id),
  sendMessage: (conversationId, body) => ipcRenderer.invoke('nestr:send-message', { conversationId, body }),

  getMonitoringStatus: () => ipcRenderer.invoke('nestr:get-monitoring-status'),
  acknowledgeMonitoring: () => ipcRenderer.invoke('nestr:acknowledge-monitoring'),

  onNewMessage: (cb) => ipcRenderer.on('nestr:new-message', (_evt, msg) => cb(msg)),
  onOpenThread: (cb) => ipcRenderer.on('nestr:open-thread', (_evt, otherId) => cb(otherId)),
  onPunchUpdated: (cb) => ipcRenderer.on('nestr:punch-updated', (_evt, state) => cb(state)),
  onLoggedOut: (cb) => ipcRenderer.on('nestr:logged-out', () => cb())
});
