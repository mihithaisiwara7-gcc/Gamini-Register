const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, '..', 'data', 'school.sqlite');
const password = String(process.env.ADMIN_PASSWORD || '@dm1n1str@t0r');
if (!fs.existsSync(dbPath)) {
  console.error('Database not found. Start the school system once, then run this reset script.');
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
try {
  const hash = bcrypt.hashSync(password, 12);
  const existing = db.prepare('SELECT id FROM staff_users WHERE lower(user_id) = lower(?)').get('Administrator');
  if (existing) {
    db.prepare("UPDATE staff_users SET user_id='Administrator', name='Administrator', role='administrator', assigned_class=NULL, active=1, password_hash=? WHERE id=?").run(hash, existing.id);
  } else {
    db.prepare('INSERT INTO staff_users (user_id,name,role,assigned_class,active,password_hash,created_at) VALUES (?,?,?,?,1,?,?)').run('Administrator','Administrator','administrator',null,hash,new Date().toISOString());
  }
  console.log('Administrator password reset successfully.');
  console.log('User ID: Administrator');
  console.log('Use the initial password from README.md, or the value supplied in ADMIN_PASSWORD.');
} finally {
  db.close();
}
