// Multiplayer: strokes and players shared in real time through Firebase Realtime Database.
// Each browser signs in anonymously; its Firebase uid is the stroke owner (only the owner can delete).
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

export async function connectLive(config, { emulator = false } = {}) {
  const [{ initializeApp }, A, D] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const db = D.getDatabase(app);
  if (emulator) {
    A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    D.connectDatabaseEmulator(db, '127.0.0.1', 9000);
  }
  const uid = (await A.signInAnonymously(auth)).user.uid;

  const strokesRef = D.ref(db, 'strokes');
  const playersRef = D.ref(db, 'players');
  const pid = `${uid}_${Math.random().toString(36).slice(2, 10)}`; // one player per tab (tabs share the uid)
  const meRef = D.ref(db, `players/${pid}`);
  let connected = false;
  let lastMe = null;
  D.onValue(D.ref(db, '.info/connected'), (s) => {
    connected = !!s.val();
    if (!connected) return;
    D.onDisconnect(meRef).remove(); // re-armed after every reconnect
    if (lastMe) D.set(meRef, lastMe).catch(() => {});
  });

  const round = (v) => Math.round(v * 1000) / 1000; // mm is plenty
  return {
    uid,
    isConnected: () => connected,
    backend: {
      name: 'live',
      async add(s) {
        const r = D.push(strokesRef);
        await D.set(r, {
          owner: uid, author: s.author, color: s.color, width: s.width,
          points: s.points.map((p) => p.map(round)), t: D.serverTimestamp(),
        });
        return r.key;
      },
      async remove(id) {
        try { await D.remove(D.ref(db, `strokes/${id}`)); return true; } catch { return false; }
      },
    },
    onStrokes(add, remove) {
      D.onChildAdded(strokesRef, (s) => {
        const v = s.val();
        add({ ...v, id: s.key, mine: v.owner === uid });
      });
      D.onChildRemoved(strokesRef, (s) => remove(s.key));
    },
    onPlayers(upsert, remove) {
      const up = (s) => { if (s.key !== pid) upsert(s.key, s.val()); };
      D.onChildAdded(playersRef, up);
      D.onChildChanged(playersRef, up);
      D.onChildRemoved(playersRef, (s) => remove(s.key));
    },
    setMe(state) {
      lastMe = {
        color: state.color,
        drawing: state.drawing ? { width: state.drawing.width, points: state.drawing.points.map((p) => p.map(round)) } : null,
      };
      if (connected) D.set(meRef, lastMe).catch(() => {});
    },
  };
}
