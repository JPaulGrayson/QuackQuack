/**
 * Voyai Client SDK for Quack
 * Server-to-Server Session Handshake (same pattern as Turai)
 * License checking and premium feature gating
 */

const VoyaiClient = {
  baseUrl: 'https://voyai.org',
  user: null,
  loading: true,
  error: null,

  // Initialize and check for session in URL
  async init() {
    this.loading = true;
    this.error = null;
    
    try {
      const params = new URLSearchParams(window.location.search);
      const sessionId = params.get('session');
      
      if (sessionId) {
        // Claim the session from our server (server-to-server handshake)
        await this.claimSession(sessionId);
      } else {
        // Check localStorage for existing session
        const stored = localStorage.getItem('voyai_user');
        if (stored) {
          try {
            this.user = JSON.parse(stored);
          } catch (e) {
            localStorage.removeItem('voyai_user');
          }
        }
      }
    } catch (err) {
      console.error('Voyai auth error:', err);
      this.error = 'Authentication failed';
    }
    
    this.loading = false;
    return this.user;
  },

  // Claim a session from Voyai (called when ?session=xxx is in URL)
  async claimSession(sessionId) {
    try {
      const response = await fetch(`/api/voyai/claim-session?session=${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      
      if (data.success && data.user) {
        // Store user in localStorage
        this.user = data.user;
        localStorage.setItem('voyai_user', JSON.stringify(data.user));
        
        // Clean URL (remove session parameter)
        const url = new URL(window.location.href);
        url.searchParams.delete('session');
        window.history.replaceState({}, '', url.toString());
        
        console.log('[Voyai] Session claimed successfully for:', data.user.email);
        return data.user;
      } else {
        this.error = data.error || 'Failed to claim session';
        console.error('[Voyai] Claim session failed:', this.error);
        return null;
      }
    } catch (err) {
      console.error('[Voyai] Claim session error:', err);
      this.error = 'Failed to claim session';
      return null;
    }
  },

  // Redirect to Voyai login
  // NOTE: Sign-in currently disabled - uncomment when ready
  loginWithVoyai() {
    // TODO: Uncomment when ready to enable sign-in
    // const returnUrl = encodeURIComponent(window.location.origin);
    // window.location.href = `${this.baseUrl}/login?return_to=${returnUrl}&app=quack`;
    
    // For now, show disabled message
    console.log('[Voyai] Sign-in temporarily disabled for testing');
    alert('Voyai sign-in is temporarily disabled. Using test mode.');
  },

  // Logout
  logout() {
    localStorage.removeItem('voyai_user');
    this.user = null;
    console.log('[Voyai] Logged out');
  },

  // Get current user
  getUser() {
    if (!this.user) {
      const stored = localStorage.getItem('voyai_user');
      if (stored) {
        try {
          this.user = JSON.parse(stored);
        } catch (e) {
          localStorage.removeItem('voyai_user');
        }
      }
    }
    return this.user;
  },

  // Legacy session getter (for backward compatibility)
  async getSession() {
    // Return cached user if available
    const user = this.getUser();
    if (user) {
      return { success: true, ...user };
    }
    return { success: false, error: 'Not authenticated' };
  },

  // Check premium status
  isPremium() {
    return this.getUser()?.tier === 'premium';
  },

  // Check feature access
  hasFeature(feature) {
    const user = this.getUser();
    return user?.features?.[feature] === true;
  },

  // Redirect to upgrade page
  redirectToUpgrade(returnUrl) {
    const url = new URL(`${this.baseUrl}/subscribe`);
    url.searchParams.set('app', 'quack');
    if (returnUrl) url.searchParams.set('return', returnUrl);
    window.location.href = url.toString();
  },

  // Feature lists
  getFreeFeatures() {
    return ['universal_inbox', 'notifications', 'workflow_management', 'file_attachments', 'auto_dispatch'];
  },

  getPremiumFeatures() {
    return ['control_room', 'multi_inbox', 'toast_notifications'];
  },

  // For backward compatibility with old code
  get session() {
    return this.getUser();
  }
};

// Initialize on page load
window.voyai = VoyaiClient;

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => VoyaiClient.init());
} else {
  VoyaiClient.init();
}
