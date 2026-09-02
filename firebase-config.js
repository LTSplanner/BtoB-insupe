/* ============================================================
   複数端末でデータを共有するための設定（Firebase）
   ------------------------------------------------------------
   ここが null のあいだは、これまでどおり「この端末だけ」で動きます。
   Firebaseプロジェクトを作ったら、コンソールで発行される設定を下に貼ってください。
   ※ ここに書く値は公開されても問題ないものです（誰が読み書きできるかは
     firestore.rules の「許可した人だけ」で守ります）
   ============================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAibwk0dB98ElGHgvUCo8um0iZRwNzB7f0",
  authDomain: "lts-nairankai.firebaseapp.com",
  projectId: "lts-nairankai",
  storageBucket: "lts-nairankai.firebasestorage.app",
  messagingSenderId: "421086712211",
  appId: "1:421086712211:web:ab6524be13465963b9d866"
};

/* 例：
window.FIREBASE_CONFIG = {
  apiKey: "AIza................",
  authDomain: "xxxx.firebaseapp.com",
  projectId: "xxxx",
  storageBucket: "xxxx.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxx"
};
*/

/* データの置き場所（変更不要） */
window.SYNC_ORG = 'lts';
