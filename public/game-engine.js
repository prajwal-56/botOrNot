// Static & Firestore Game Manager
(function() {
  const SALT = 'bon_salt_2026';
  const DURATION_MINUTES = (window.GAME_SETTINGS && window.GAME_SETTINGS.durationMinutes) || 3;
  const POINTS_PER_CORRECT = (window.GAME_SETTINGS && window.GAME_SETTINGS.pointsPerCorrect) || 10;


  // SHA-256 with fallback when crypto.subtle is unavailable (e.g. non-HTTPS/insecure contexts)
  async function sha256Prefix(text) {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
      } catch (e) {
        console.warn('[GameEngine] crypto.subtle failed, using JS fallback:', e);
      }
    }
    return jsSha256(text).slice(0, 16);
  }

  // Pure JS SHA-256 fallback
  function jsSha256(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let i, j;
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;
    let hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = candidate * candidate; i < 313; i += candidate) {
          isComposite[i] = true;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    hash = hash.slice(0, 8);
    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return;
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        w[i] = (i < 16) ? w[i] : (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        const s1_temp = rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
        const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
        const temp1 = (hash[7] + s1_temp + ch + k[i] + w[i]) | 0;
        const s0_temp = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
        const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
        const temp2 = (s0_temp + maj) | 0;
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (let b = 3; b >= 0; b--) {
        const byte = (hash[i] >> (8 * b)) & 255;
        result += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return result;
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

  // ── Private: log session info to Firestore (fire-and-forget) ────
  async function _logSession(username, durationSeconds) {
    if (!db) return;
    try {
      // Get public IP via ipify (free, no auth needed)
      let ip = 'unknown';
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipRes.json();
        ip = ipData.ip || 'unknown';
      } catch (_) { /* ipify unreachable — still log everything else */ }

      await db.collection('sessions').add({
        username,
        ip,
        durationSeconds,
        // Browser / device info — all freely available, no permissions needed
        userAgent  : navigator.userAgent,
        language   : navigator.language,
        timezone   : Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen     : `${screen.width}x${screen.height}`,
        platform   : navigator.platform || 'unknown',
        referrer   : document.referrer || 'direct',
        timestamp  : Date.now()
      });
    } catch (e) {
      console.warn('[GameEngine] Session log failed:', e);
    }
  }

  window.GameEngine = {
    durationMinutes: DURATION_MINUTES,
    pointsPerCorrect: POINTS_PER_CORRECT,
    logSession: _logSession,

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

  // Start player session with duration in seconds (defaults to window.GAME_SETTINGS or 60s)
  async startSession(username, durationSeconds) {
    const defaultSecs = ((window.GAME_SETTINGS && window.GAME_SETTINGS.durationMinutes) || 1) * 60;
    const finalSecs = durationSeconds ? parseInt(durationSeconds, 10) : defaultSecs;
    const now = Date.now();
    const endTime = now + finalSecs * 1000;

    sessionStorage.setItem('bon_username', username);
    sessionStorage.setItem('bon_endTime', new Date(endTime).toISOString());
    sessionStorage.setItem('bon_duration_seconds', String(finalSecs));
    sessionStorage.setItem('bon_served', JSON.stringify([]));
    sessionStorage.setItem('bon_score', '0');
    sessionStorage.setItem('bon_correct', '0');
    sessionStorage.setItem('bon_total', '0');

    // Register active session in Firestore with server timestamp
    if (db) {
      try {
        await db.collection('active_sessions').doc(username).set({
          username,
          durationSeconds: finalSecs,
          startedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.warn('[GameEngine] Failed to register active session:', e);
      }
    }

    // Fire-and-forget: log session info to Firestore (non-blocking)
    _logSession(username, finalSecs);

    return { username, endTime, durationSeconds: finalSecs };
  },

    // Check choice correctness via hash verification
    async verifyAnswer(item, choice) {
      const testHash = await sha256Prefix(`${item.id}:${choice}:${SALT}`);
      return testHash === item.correctHash;
    },

    // Save final or live score
    async recordScore(username, points, correctCount, totalAnswered) {
      const durationSeconds = parseInt(sessionStorage.getItem('bon_duration_seconds') || '60', 10);

      // ── Sanity checks (client-side mirror of Firestore rules) ──
      const maxPossiblePoints = totalAnswered * POINTS_PER_CORRECT;
      if (
        points < 0 ||
        correctCount < 0 ||
        totalAnswered < 0 ||
        correctCount > totalAnswered ||
        points > maxPossiblePoints ||
        points !== correctCount * POINTS_PER_CORRECT ||
        totalAnswered > durationSeconds * 2
      ) {
        console.warn('[GameEngine] recordScore blocked — implausible values.');
        return;
      }
      // 1. Always keep local copy
      const localLb = JSON.parse(localStorage.getItem('bon_leaderboard') || '[]');
      const existing = localLb.findIndex(p => p.username === username);
      const entry = {
        username,
        points,
        correctCount,
        totalAnswered,
        durationSeconds,
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

    // Get leaderboard entries — pass a Firestore doc snapshot as `afterCursor` for pagination
    async getLeaderboard(afterCursor = null, pageSize = 25) {
      if (db) {
        try {
          let query = db.collection('leaderboard')
            .orderBy('points', 'desc')
            .limit(pageSize);
          if (afterCursor) query = query.startAfter(afterCursor);
          const snap = await query.get();
          const remote = [];
          snap.forEach(doc => remote.push({ _snap: doc, ...doc.data() }));
          if (remote.length > 0) return remote;
        } catch (e) {
          console.warn('[Firestore] Error fetching leaderboard, falling back to local:', e);
        }
      }
      // Local fallback (no pagination support needed — local list is small)
      const local = JSON.parse(localStorage.getItem('bon_leaderboard') || '[]');
      const start = afterCursor ? afterCursor._localIndex : 0;
      return local.slice(start, start + pageSize).map((r, i) => ({ ...r, _localIndex: start + i + 1 }));
    }
  };
})();
