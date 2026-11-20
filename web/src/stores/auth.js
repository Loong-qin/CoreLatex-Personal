import { defineStore } from 'pinia';
import { api, getToken, setToken } from '../api.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    user: null,
    usage: null,
  }),
  getters: {
    isAdmin: (s) => s.user?.role === 'admin',
    loggedIn: (s) => !!s.token,
  },
  actions: {
    async login(username, password) {
      const data = await api.post('/api/auth/login', { username, password });
      this.token = data.token;
      setToken(data.token);
      this.user = data.user;
      return data.user;
    },
    async register(username, password, displayName) {
      await api.post('/api/auth/register', { username, password, displayName });
      return this.login(username, password);
    },
    async fetchMe() {
      const token = this.token;
      if (!token) return null;
      try {
        // Identity and basic quotas are available without traversing projects.
        const data = await api.get('/api/auth/me?summary=1');
        if (this.token !== token) return null;
        this.user = data.user;
        if (data.usage) {
          // A full usage request may have won the race with this summary.
          const storageUsed = data.usage.storageUsed == null && Number.isFinite(this.usage?.storageUsed)
            ? this.usage.storageUsed : data.usage.storageUsed;
          this.usage = { ...data.usage, storageUsed };
        }
        return data.user;
      } catch {
        return null;
      }
    },
    async refreshUsage({ signal } = {}) {
      const token = this.token;
      try {
        const usage = await api.get('/api/users/me/usage', signal ? { signal } : undefined);
        if (!signal?.aborted && this.token === token) this.usage = usage;
      } catch { /* Keep the last known usage until a later successful refresh. */ }
    },
    logout() {
      this.token = '';
      this.user = null;
      this.usage = null;
      setToken('');
    },
  },
});
