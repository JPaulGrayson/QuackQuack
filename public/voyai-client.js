/**
 * Voyai Client SDK for Quack
 * License checking and premium feature gating
 */

const VoyaiClient = {
  baseUrl: 'https://voyai.org',
  session: null,

  async register(email) {
    const res = await fetch(`${this.baseUrl}/api/quack/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (data.success) {
      this.session = data;
      localStorage.setItem('voyai_session', JSON.stringify(data));
    }
    return data;
  },

  async getSession() {
    try {
      const res = await fetch(`${this.baseUrl}/api/quack/session`, {
        method: 'GET',
        credentials: 'include'
      });
      const data = await res.json();
      if (data.success) {
        this.session = data;
        localStorage.setItem('voyai_session', JSON.stringify(data));
      }
      return data;
    } catch (e) {
      const cached = localStorage.getItem('voyai_session');
      if (cached) {
        this.session = JSON.parse(cached);
        return this.session;
      }
      return { success: false, error: 'Not authenticated' };
    }
  },

  isPremium() {
    return this.session?.tier === 'premium';
  },

  hasFeature(feature) {
    return this.session?.features?.[feature] === true;
  },

  redirectToUpgrade(returnUrl) {
    const url = new URL(`${this.baseUrl}/subscribe`);
    url.searchParams.set('app', 'quack');
    if (returnUrl) url.searchParams.set('return', returnUrl);
    window.location.href = url.toString();
  },

  getFreeFeatures() {
    return ['universal_inbox', 'notifications', 'workflow_management', 'file_attachments', 'auto_dispatch'];
  },

  getPremiumFeatures() {
    return ['control_room', 'multi_inbox', 'toast_notifications'];
  }
};

window.voyai = VoyaiClient;
