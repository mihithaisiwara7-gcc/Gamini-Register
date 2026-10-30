const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, '..', 'data', 'school.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error('Database not found. Run npm start once to initialize the school system, then retry.');
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
try {
  const userId = 'admin';
  const name = 'Administrator';
  const role = 'administrator';
  const passwordHash = bcrypt.hashSync('Admin123', 12);
  const existing = db.prepare('SELECT id FROM staff_users WHERE lower(user_id) = lower(?)').get(userId);
  if (existing) {
    db.prepare("UPDATE staff_users SET user_id=?, name=?, role=?, assigned_class=NULL, active=1, password_hash=? WHERE id=?")
      .run(userId, name, role, passwordHash, existing.id);
  } else {
    db.prepare('INSERT INTO staff_users (user_id,name,role,assigned_class,active,password_hash,created_at) VALUES (?,?,?,?,1,?,?)')
      .run(userId, name, role, null, passwordHash, new Date().toISOString());
  }
  const verified = db.prepare('SELECT user_id, role, active, password_hash FROM staff_users WHERE lower(user_id)=lower(?)').get(userId);
  if (!verified || verified.role !== role || verified.active !== 1 || !bcrypt.compareSync('Admin123', verified.password_hash)) {
    throw new Error('Administrator account verification failed.');
  }
  console.log('Administrator account created/updated and verified.');
  console.log('User ID: admin');
  console.log('Password: Admin123');
  console.log('DB/1–DB/6 access: Administrator uses this application ID/password without separate database passwords. Principal can access DB/1–DB/3 and DB/5–DB/6 without database passwords, but must provide the DB/4 password.');
} finally {
  db.close();
}
