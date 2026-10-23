// Static & Firestore Game Manager
(function() {
  const SALT = 'bon_salt_2026';
  const DURATION_MINUTES = 3; // default game session duration
  const POINTS_PER_CORRECT = 10;

  // Simple SHA-256 for browser
  async function sha256Prefix(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  // Initialize Firebase Firestore if configured
  let db = null;
  try {
    if (window.firebase && window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY') {
      if (!firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      db = firebase.firestore();
    }
  } catch (err) {
    console.warn('[Firebase] Running in offline / local-storage fallback mode:', err);
  }

  window.GameEngine = {
    durationMinutes: DURATION_MINUTES,
    pointsPerCorrect: POINTS_PER_CORRECT,

    // Load images list
    async loadCatalog() {
      const cached = sessionStorage.getItem('bon_catalog');
      if (cached) {
        return JSON.parse(cached);
      }
      const res = await fetch('/assets/images.json');
      const data = await res.json();
      sessionStorage.setItem('bon_catalog', JSON.stringify(data));
      return data;
    },

    // Start player session
    startSession(username) {
      const now = Date.now();
      const endTime = now + DURATION_MINUTES * 60 * 1000;
      sessionStorage.setItem('bon_username', username);
      sessionStorage.setItem('bon_endTime', new Date(endTime).toISOString());
      sessionStorage.setItem('bon_duration', DURATION_MINUTES);
      sessionStorage.setItem('bon_served', JSON.stringify([]));
      sessionStorage.setItem('bon_score', '0');
      sessionStorage.setItem('bon_correct', '0');
      sessionStorage.setItem('bon_total', '0');
      return { username, endTime };
    },

    // Check choice correctness via hash verification
    async verifyAnswer(item, choice) {
      const testHash = await sha256Prefix(`${item.id}:${choice}:${SALT}`);
      return testHash === item.correctHash;
    },

    // Save final or live score
    async recordScore(username, points, correctCount, totalAnswered) {
      // 1. Always keep local copy
      const localLb = JSON.parse(localStorage.getItem('bon_leaderboard') || '[]');
      const existing = localLb.findIndex(p => p.username === username);
      const entry = {
        username,
        points,
        correctCount,
        totalAnswered,
        timestamp: Date.now()
      };
      if (existing >= 0) {
        if (points > localLb[existing].points) {
          localLb[existing] = entry;
        }
      } else {
        localLb.push(entry);
      }
      localLb.sort((a, b) => b.points - a.points);
      localStorage.setItem('bon_leaderboard', JSON.stringify(localLb));

      // 2. If Firestore is connected, sync to Cloud Firestore
      if (db) {
        try {
          const userDoc = db.collection('leaderboard').doc(username);
          const snap = await userDoc.get();
          if (!snap.exists || (snap.data().points || 0) < points) {
            await userDoc.set(entry, { merge: true });
          }
        } catch (e) {
          console.error('[Firestore] Failed to save leaderboard:', e);
        }
      }
    },

    // Get leaderboard entries
    async getLeaderboard() {
      if (db) {
        try {
          const snap = await db.collection('leaderboard')
            .orderBy('points', 'desc')
            .limit(50)
            .get();
          const remote = [];
          snap.forEach(doc => remote.push(doc.data()));
          if (remote.length > 0) return remote;
        } catch (e) {
          console.warn('[Firestore] Error fetching leaderboard, falling back to local:', e);
        }
      }
      return JSON.parse(localStorage.getItem('bon_leaderboard') || '[]');
    }
  };
})();
