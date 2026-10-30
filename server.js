require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'school.sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
	  CREATE TABLE IF NOT EXISTS student_information (
	    id INTEGER PRIMARY KEY AUTOINCREMENT,
	    student_id TEXT NOT NULL UNIQUE,
	    register_number INTEGER,
	    house TEXT CHECK (house IN ('Yellow','Red','Blue')),
	    identification_number TEXT,
	    full_name TEXT NOT NULL,
    date_of_birth TEXT NOT NULL,
    gender TEXT NOT NULL CHECK (gender IN ('Male','Female','Other')),
    guardian_name TEXT NOT NULL,
    guardian_phone TEXT NOT NULL,
    address TEXT NOT NULL,
    emergency_contact TEXT NOT NULL,
    notes TEXT DEFAULT '',
    class_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','transferred','left')),
    date_added TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_students_class ON student_information(class_name, status);

  CREATE TABLE IF NOT EXISTS daily_registration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_date TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    class_name TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    total_students INTEGER NOT NULL,
    present INTEGER NOT NULL,
    absent INTEGER NOT NULL,
    male_present INTEGER NOT NULL,
    female_present INTEGER NOT NULL,
    male_absent INTEGER NOT NULL,
    female_absent INTEGER NOT NULL,
    absent_students_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(registration_date, class_name)
  );
  CREATE INDEX IF NOT EXISTS idx_registration_date ON daily_registration(registration_date);

  CREATE TABLE IF NOT EXISTS staff_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    assigned_class TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login TEXT
  );
  CREATE TABLE IF NOT EXISTS staff_registration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_date TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Teacher','Principal','Vice principal','Assistant Principal','Other academic staff','Non academic staff')),
    reported_time TEXT,
    departure_time TEXT,
    registered_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_staff_registration_date ON staff_registration(registration_date);
  CREATE INDEX IF NOT EXISTS idx_staff_registration_staff ON staff_registration(staff_id, registration_date);

  CREATE TABLE IF NOT EXISTS absence_reasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reason_date TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    class_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    UNIQUE(reason_date, student_id)
  );
  CREATE INDEX IF NOT EXISTS idx_absence_reasons_date ON absence_reasons(reason_date, class_name);

  CREATE TABLE IF NOT EXISTS principal_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_principal_messages_created ON principal_messages(created_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    record_ref TEXT,
    class_name TEXT,
    details TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS database_passwords (
    database_number INTEGER PRIMARY KEY CHECK (database_number BETWEEN 1 AND 4),
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
`);

// Migration: staff registration now stores Name, ID and Role only (times optional),
// and supports the current staff role list.
(function migrateStaffRegistration() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='staff_registration'").get();
  if (!row || !row.sql) return;
  const needsRebuild = row.sql.includes("'Assistant principal'") || /reported_time TEXT NOT NULL/.test(row.sql);
  if (!needsRebuild) return;
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE staff_registration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        registration_date TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('Teacher','Principal','Vice principal','Assistant Principal','Other academic staff','Non academic staff')),
        reported_time TEXT,
        departure_time TEXT,
        registered_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO staff_registration_new (id,registration_date,staff_id,name,role,reported_time,departure_time,registered_by,created_at,updated_at)
      SELECT id,registration_date,staff_id,name,
        CASE role
          WHEN 'Assistant principal' THEN 'Assistant Principal'
          WHEN 'Vice Principal' THEN 'Vice principal'
          ELSE role END,
        reported_time,departure_time,registered_by,created_at,updated_at
      FROM staff_registration
      WHERE role IN ('Teacher','Principal','Vice principal','Vice Principal','Assistant principal','Assistant Principal','Other academic staff','Non academic staff');
    `);
    db.exec('DROP TABLE staff_registration;');
    db.exec('ALTER TABLE staff_registration_new RENAME TO staff_registration;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_registration_date ON staff_registration(registration_date);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_registration_staff ON staff_registration(staff_id, registration_date);');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
})();

// Migrate older SQLite databases safely: retain the latest reason for each student/day.
(function migrateParentTools() {
  db.exec(`DELETE FROM absence_reasons WHERE id NOT IN (SELECT MAX(id) FROM absence_reasons GROUP BY reason_date, student_id)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_absence_reason_one_per_student_day ON absence_reasons(reason_date, student_id)');
  const legacy = db.prepare("SELECT value FROM system_metadata WHERE key='principal_message'").get();
  if (legacy?.value && legacy.value.trim() && db.prepare('SELECT COUNT(*) AS n FROM principal_messages').get().n === 0) {
    const by = 'MIGRATION'; const created = db.prepare("SELECT value FROM system_metadata WHERE key='principal_message_updated'").get()?.value || new Date().toISOString();
    db.prepare('INSERT INTO principal_messages(message,created_by,created_at) VALUES (?,?,?)').run(legacy.value, by, created);
  }
})();

// Migration: add the class register number, house, and unrestricted identification number.
(function migrateStudentFields() {
  const columns = db.prepare("PRAGMA table_info(student_information)").all().map(row => row.name);
  if (!columns.includes('register_number')) db.exec('ALTER TABLE student_information ADD COLUMN register_number INTEGER');
  if (!columns.includes('house')) db.exec("ALTER TABLE student_information ADD COLUMN house TEXT CHECK (house IN ('Yellow','Red','Blue'))");
  if (!columns.includes('identification_number')) db.exec('ALTER TABLE student_information ADD COLUMN identification_number TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_register_number ON student_information(class_name, register_number) WHERE register_number IS NOT NULL');
})();

const GRADES = {
  6: ['A', 'B', 'C'], 7: ['A', 'B', 'C'], 8: ['A', 'B', 'C'],
  9: ['A', 'B', 'C'], 10: ['A', 'B', 'C'], 11: ['A', 'B', 'C'],
  12: ['A', 'C', 'T', 'S'], 13: ['A', 'C', 'T', 'S']
};
const CLASSES = Object.entries(GRADES).flatMap(([grade, sections]) => sections.map(section => `${grade}${section}`));
const ADMIN_ROLES = ['Principal', 'Vice Principal', 'Assistant Principal', 'administrator'];
const STAFF_REGISTRATION_ROLES = ['Teacher', 'Principal', 'Vice principal', 'Assistant Principal', 'Other academic staff', 'Non academic staff'];
const TEACHER_ROLES = ['Class Teacher', 'Assistant Class Teacher'];
const DEFAULT_DB_PASSWORDS = {
  1: process.env.DB1_PASSWORD || 'DB1@123',
  2: process.env.DB2_PASSWORD || 'DB2@123',
  3: process.env.DB3_PASSWORD || 'DB3@123',
  4: process.env.DB4_PASSWORD || 'DB4@123'
};
const DEFAULT_ADMIN_PASSWORD = '@dm1n1str@t0r';
const ADMINISTRATOR_ROLE = 'administrator';
const SENSITIVE_STUDENT_FIELDS = ['guardian_name', 'guardian_phone', 'address', 'emergency_contact', 'notes'];
const sessions = new Map();
const dbAccessSessions = new Map();
const COOKIE_MAX_AGE = 8 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const todayKey = () => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const part = type => parts.find(item => item.type === type)?.value || ''; return `${part('year')}-${part('month')}-${part('day')}`; };
const currentTimeKey = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const currentWeekStartIso = () => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date()); const get=t=>parts.find(p=>p.type===t)?.value; const [year,month,day]=[Number(get('year')),Number(get('month')),Number(get('day'))]; const weekday=new Date(Date.UTC(year,month-1,day,12)).getUTCDay(); return new Date(Date.UTC(year,month-1,day-weekday,-5,-30)).toISOString(); };
const CURRENT_SCHOOL_YEAR = Number(process.env.SCHOOL_YEAR || new Date().getFullYear());
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-session-secret-change-before-deployment';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'development-encryption-key-change-before-deployment').digest();

function normalizeClass(value) {
  if (!value) return '';
  const clean = String(value).trim().toUpperCase().replace(/^GRADE\s*/i, '').replace(/[\s_-]+/g, '');
  const match = clean.match(/^(\d{1,2})([ABCST])$/);
  if (!match) return '';
  const grade = Number(match[1]);
  const section = match[2];
  if (grade < 6 || grade > 13) return '';
  if (grade >= 6 && grade <= 11 && !['A', 'B', 'C'].includes(section)) return '';
  if ((grade === 12 || grade === 13) && !['A', 'C', 'T', 'S'].includes(section)) return '';
  return `${grade}${section}`;
}

function classFromParts(grade, section) {
  return normalizeClass(`${grade}${section}`);
}

function isValidClass(className) {
  return CLASSES.includes(normalizeClass(className));
}

function buildTeacherUserId(role, className, year = CURRENT_SCHOOL_YEAR) {
  const normalizedClass = normalizeClass(className);
  if (!normalizedClass) return null;
  const prefix = role === 'Assistant Class Teacher' ? 'ACT' : 'CT';
  return `${prefix}-${normalizedClass}-${year}`;
}

function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }));
}

function setCookie(res, name, value, maxAge = COOKIE_MAX_AGE) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Max-Age=${Math.floor(maxAge / 1000)}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function safeUser(user) {
  if (!user) return null;
  return { id: user.user_id, name: user.name, role: user.role, assignedClass: user.assigned_class || null, active: Boolean(user.active) };
}

function issueSession(user) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const token = crypto.createHmac('sha256', SESSION_SECRET).update(nonce).digest('hex');
  sessions.set(token, { userId: user.user_id, createdAt: Date.now() });
  return token;
}

function getCurrentUser(req) {
  const token = parseCookies(req).school_session;
  const session = token && sessions.get(token);
  if (!session || Date.now() - session.createdAt > COOKIE_MAX_AGE) return null;
  return db.prepare('SELECT * FROM staff_users WHERE user_id = ? AND active = 1').get(session.userId) || null;
}

function audit(userId, action, recordRef = '', className = '', details = '') {
  db.prepare('INSERT INTO audit_log (timestamp,user_id,action,record_ref,class_name,details) VALUES (?,?,?,?,?,?)')
    .run(nowIso(), userId || null, action, recordRef, className || null, details);
}

function publicError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAuth(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return publicError(res, 401, 'Please log in to continue.');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_ROLES.includes(req.user.role)) return publicError(res, 403, 'You do not have permission to perform this action.');
  next();
}

function requirePrincipalOrAdmin(req, res, next) {
  if (!['Principal', ADMINISTRATOR_ROLE].includes(req.user.role)) return publicError(res, 403, 'Only the Principal or Administrator can access this area.');
  next();
}

function ownsClass(user, className) {
  const normalized = normalizeClass(className);
  return ADMIN_ROLES.includes(user.role) || (TEACHER_ROLES.includes(user.role) && user.assigned_class === normalized);
}

function canReadClass(user, className) {
  const normalized = normalizeClass(className);
  return ADMIN_ROLES.includes(user.role) || (TEACHER_ROLES.includes(user.role) && isValidClass(normalized));
}

function ageFromDob(dob) {
  const date = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date > new Date()) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - date.getUTCFullYear();
  const month = today.getUTCMonth() - date.getUTCMonth();
  if (month < 0 || (month === 0 && today.getUTCDate() < date.getUTCDate())) age--;
  return age >= 0 ? age : null;
}

function encryptValue(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value ?? ''), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptValue(value) {
  if (!value || !String(value).startsWith('enc:v1:')) return value || '';
  try {
    const [, , ivHex, tagHex, dataHex] = String(value).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (error) {
    return '[protected data unavailable]';
  }
}

function protectStudentFields(values) {
  const result = { ...values };
  SENSITIVE_STUDENT_FIELDS.forEach(field => {
    if (field in result) result[field] = encryptValue(result[field]);
  });
  return result;
}

function revealStudent(student) {
  if (!student) return student;
  const result = { ...student };
  SENSITIVE_STUDENT_FIELDS.forEach(field => {
    result[field] = decryptValue(result[field]);
  });
  return result;
}

function studentView(student) {
  return { ...revealStudent(student), age: ageFromDob(student.date_of_birth) };
}

function registrationView(row) {
  if (!row) return null;
  return { ...row, absent_students: JSON.parse(row.absent_students_json || '[]') };
}

function validateStudent(body, partial = false) {
	  const fields = ['student_id', 'full_name', 'date_of_birth', 'gender', 'guardian_name', 'guardian_phone', 'address', 'emergency_contact', 'class_name', 'register_number', 'house', 'identification_number'];
	  if (!partial && fields.some(field => !cleanText(body[field]))) return 'Please complete all required student fields.';
	  if (body.gender && !['Male', 'Female', 'Other'].includes(body.gender)) return 'Please select a valid gender.';
	  if (body.house && !['Yellow', 'Red', 'Blue'].includes(body.house)) return 'Please select a valid house.';
	  if (body.register_number !== undefined && body.register_number !== '' && (!Number.isInteger(Number(body.register_number)) || Number(body.register_number) < 1 || Number(body.register_number) > 100)) return 'Register number must be between 1 and 100.';
	  if (body.date_of_birth && ageFromDob(body.date_of_birth) === null) return 'Please enter a valid date of birth.';
	  if (body.class_name && !isValidClass(body.class_name)) return 'Please select a valid school class.';
	  return null;
}

function cleanup() {
  const cutoff365 = new Date();
  cutoff365.setUTCDate(cutoff365.getUTCDate() - 365);
  const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const oldStudents = db.prepare("DELETE FROM student_information WHERE status IN ('inactive','transferred','left') AND date_added < ?").run(cutoff365.toISOString());
  const oldRegistrations = db.prepare('DELETE FROM daily_registration WHERE submitted_at < ?').run(cutoff24.toISOString());
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const oldStaffRegistrations = db.prepare('DELETE FROM staff_registration WHERE registration_date < ?').run(yearStart);

  if (oldStudents.changes) audit('SYSTEM', 'Cleanup expired student records', `${oldStudents.changes} records`, '', 'Retention policy: 365 days');
  if (oldRegistrations.changes) audit('SYSTEM', 'Cleanup expired daily registrations', `${oldRegistrations.changes} records`, '', 'Retention policy: 24 hours');
  if (oldStaffRegistrations.changes) audit('SYSTEM', 'Cleanup expired staff registration records', `${oldStaffRegistrations.changes} records`, '', 'Retention policy: current school year (cleared at year end)');
  const expiredReasons = db.prepare('DELETE FROM absence_reasons WHERE reason_date < ?').run(todayKey());
  const weeklyCutoff = currentWeekStartIso();
  const expiredMessages = db.prepare('DELETE FROM principal_messages WHERE created_at < ?').run(weeklyCutoff);

  return { students: oldStudents.changes, registrations: oldRegistrations.changes, staffRegistrations: oldStaffRegistrations.changes, absenceReasons: expiredReasons.changes, principalMessages: expiredMessages.changes };
}

function createAdminUserRecord(userId, name, role, password = DEFAULT_ADMIN_PASSWORD) {
  const rawId = cleanText(userId, 50).replace(/\s+/g, '');
  const normalizedId = rawId.toLowerCase() === 'administrator' ? 'Administrator' : (rawId.toLowerCase() === 'admin' ? 'admin' : rawId.toUpperCase());
  const adminRole = role === ADMINISTRATOR_ROLE ? ADMINISTRATOR_ROLE : (ADMIN_ROLES.includes(role) ? role : 'Principal');
  if (!normalizedId || !name || (!ADMIN_ROLES.includes(adminRole) && adminRole !== ADMINISTRATOR_ROLE)) return null;

  const hash = bcrypt.hashSync(String(password || DEFAULT_ADMIN_PASSWORD), 12);
  const existing = db.prepare('SELECT * FROM staff_users WHERE user_id = ?').get(normalizedId);

  if (existing) {
    db.prepare('UPDATE staff_users SET name=?,role=?,assigned_class=?,active=?,password_hash=? WHERE user_id=?')
      .run(name, adminRole, null, 1, hash, normalizedId);
    return { user_id: normalizedId, name, role: adminRole, assigned_class: null };
  }

  db.prepare('INSERT INTO staff_users (user_id,name,role,assigned_class,active,password_hash,created_at) VALUES (?,?,?,?,1,?,?)')
    .run(normalizedId, name, adminRole, null, hash, nowIso());

  return { user_id: normalizedId, name, role: adminRole, assigned_class: null };
}

function seedIfEmpty() {
  const initialized = db.prepare("SELECT value FROM system_metadata WHERE key = 'clean_slate_v4'").get();
  if (!initialized) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM staff_users').run();
      db.prepare("INSERT OR REPLACE INTO system_metadata (key,value) VALUES ('clean_slate_v4',?)").run(nowIso());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  // Ensure both supported administrator IDs exist. Do not reset their passwords on every server restart.
  const legacyAdmin = db.prepare('SELECT 1 FROM staff_users WHERE lower(user_id) = lower(?)').get('Administrator');
  if (!legacyAdmin) createAdminUserRecord('Administrator', 'Administrator', ADMINISTRATOR_ROLE, DEFAULT_ADMIN_PASSWORD);
  const shortAdmin = db.prepare('SELECT 1 FROM staff_users WHERE lower(user_id) = lower(?)').get('admin');
  if (!shortAdmin) createAdminUserRecord('admin', 'Administrator', ADMINISTRATOR_ROLE, 'Admin123');
}

seedIfEmpty();
for (const [number, password] of Object.entries(DEFAULT_DB_PASSWORDS)) {
  if (!db.prepare('SELECT 1 FROM database_passwords WHERE database_number = ?').get(Number(number))) {
    db.prepare('INSERT INTO database_passwords (database_number,password_hash,updated_at,updated_by) VALUES (?,?,?,?)').run(Number(number), bcrypt.hashSync(String(password), 12), nowIso(), 'SYSTEM');
  }
}

cleanup();
setInterval(cleanup, 60 * 1000).unref();
(function scheduleLocalMidnightCleanup() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value;
  const [year,month,day]=[Number(get('year')),Number(get('month')),Number(get('day'))];
  const nextMidnightUtc = Date.UTC(year, month - 1, day + 1, -5, -30);
  const timer = setTimeout(() => { cleanup(); scheduleLocalMidnightCleanup(); }, Math.max(1, nextMidnightUtc - Date.now()));
  timer.unref();
})();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/session', (req, res) => res.json({ user: safeUser(getCurrentUser(req)), classes: CLASSES, grades: GRADES }));
// Public parent tools: expose only a child's attendance status, never private contact details.
app.post('/api/parent/verify', (req, res) => {
  const studentId = cleanText(req.body.studentId, 100);
  const className = normalizeClass(req.body.className);
  if (!studentId || !className) return publicError(res, 400, 'Enter the student ID and a valid class.');
  const student = db.prepare("SELECT student_id,full_name,class_name FROM student_information WHERE student_id = ? AND class_name = ? AND status = 'active'").get(studentId, className);
  if (!student) return publicError(res, 404, 'No active student matched that ID and class. Please check the details.');
  const registration = db.prepare('SELECT absent_students_json FROM daily_registration WHERE registration_date = ? AND class_name = ?').get(todayKey(), className);
  if (!registration) return res.json({ studentName: student.full_name, className, date: todayKey(), status: 'not-submitted', message: 'The class has not submitted attendance yet.' });
  const absent = JSON.parse(registration.absent_students_json || '[]').some(item => item.studentId === student.student_id);
  res.json({ studentName: student.full_name, className, date: todayKey(), status: absent ? 'absent' : 'present', message: absent ? 'Marked ABSENT today.' : 'Marked PRESENT today.' });
});

app.post('/api/parent/absence-reason', (req, res) => {
  // Parents may submit a reason from 06:00 through 10:00 Asia/Colombo,
  // even if the class teacher has not yet submitted today's attendance.
  const schoolTime = currentTimeKey();
  if (schoolTime < '06:00' || schoolTime > '10:00') {
    return publicError(res, 400, 'Absence reasons can be submitted daily between 6:00 AM and 10:00 AM Sri Lanka time.');
  }
  const studentId = cleanText(req.body.studentId, 100);
  const studentName = cleanText(req.body.studentName, 120);
  const className = normalizeClass(req.body.className);
  const reason = cleanText(req.body.reason, 500);
  if (!studentId || !studentName || !className || !reason) return publicError(res, 400, 'Complete the student name, ID, class, and reason.');
  const student = db.prepare("SELECT student_id,full_name,class_name FROM student_information WHERE student_id = ? AND class_name = ? AND status = 'active'").get(studentId, className);
  if (!student || student.full_name.toLowerCase() !== studentName.toLowerCase()) return publicError(res, 404, 'The student details do not match an active student record.');
  // Do not require teacher attendance to be submitted first; the parent reason
  // is stored against today's date and can be reviewed by staff later.
  const timestamp = nowIso();
  db.prepare('INSERT INTO absence_reasons (reason_date,student_id,student_name,class_name,reason,submitted_at) VALUES (?,?,?,?,?,?) ON CONFLICT(reason_date,student_id) DO UPDATE SET student_name=excluded.student_name,class_name=excluded.class_name,reason=excluded.reason,submitted_at=excluded.submitted_at').run(todayKey(), studentId, student.full_name, className, reason, timestamp);
  res.status(201).json({ message: 'Absence reason saved for today.' });
});

app.get('/api/parent/birthdays', (req, res) => {
  const today = todayKey();
  const monthDay = today.slice(5);
  const students = db.prepare("SELECT student_id,full_name,class_name,date_of_birth FROM student_information WHERE status = 'active' AND substr(date_of_birth,6,5) = ? ORDER BY full_name COLLATE NOCASE").all(monthDay);
  res.json({ date: today, students });
});

app.get('/api/parent/message', (req, res) => {
  const row = db.prepare('SELECT id,message,created_at FROM principal_messages ORDER BY created_at DESC,id DESC LIMIT 1').get();
  res.json({ message: row?.message || '', updatedAt: row?.created_at || null });
});

app.put('/api/admin/parent-tools/message', requireAuth, requirePrincipalOrAdmin, (req, res) => {
  const message = cleanText(req.body.message, 1000);
  if (!message) return publicError(res, 400, 'Enter a principal message.');
  const result = db.prepare('INSERT INTO principal_messages(message,created_by,created_at) VALUES (?,?,?)').run(message, req.user.user_id, nowIso());
  audit(req.user.user_id, 'Principal message published', `DB/6:${result.lastInsertRowid}`, '', message.slice(0, 160));
  res.json({ message: 'Principal message published.' });
});

app.get('/api/admin/parent-tools/absence-reasons', requireAuth, requirePrincipalOrAdmin, (req, res) => {
  const rows = db.prepare('SELECT id,reason_date,student_id,student_name,class_name,reason,submitted_at FROM absence_reasons WHERE reason_date = ? ORDER BY submitted_at DESC').all(cleanText(req.query.date,10) || todayKey());
  res.json({ reasons: rows });
});

app.put('/api/admin/parent-tools/absence-reasons/:id', requireAuth, requirePrincipalOrAdmin, (req, res) => {
  const id = Number(req.params.id); const reason = String(req.body.reason ?? '').trim();
  if (!Number.isSafeInteger(id) || id < 1 || !reason || [...reason].length > 500) return publicError(res, 400, 'Enter a reason of 1–500 characters.');
  const result = db.prepare('UPDATE absence_reasons SET reason=?,submitted_at=? WHERE id=? AND reason_date=?').run(reason, nowIso(), id, todayKey());
  if (!result.changes) return publicError(res, 404, 'Today’s absence reason was not found.');
  audit(req.user.user_id, 'Absence reason edited', `DB/5:${id}`, '', reason.slice(0,160));
  res.json({ message: 'Absence reason updated.' });
});

app.get('/api/db/5/absence-reasons', requireAuth, requirePrincipalOrAdmin, (req,res) => {
  const date = cleanText(req.query.date,10) || todayKey();
  const reasons = db.prepare('SELECT id,reason_date,student_id,student_name,class_name,reason,submitted_at FROM absence_reasons WHERE reason_date=? ORDER BY class_name,student_name COLLATE NOCASE').all(date);
  res.json({reasons});
});
app.get('/api/db/6/messages', requireAuth, requirePrincipalOrAdmin, (req,res) => {
  res.json({messages:db.prepare('SELECT id,message,created_by,created_at FROM principal_messages ORDER BY created_at DESC,id DESC').all()});
});
app.delete('/api/db/6/messages/:id', requireAuth, requirePrincipalOrAdmin, (req,res) => {
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) return publicError(res,400,'Invalid message ID.');
  const result=db.prepare('DELETE FROM principal_messages WHERE id=?').run(id); if(!result.changes) return publicError(res,404,'Principal message not found.');
  audit(req.user.user_id,'Principal message deleted',`DB/6:${id}`,'','Manually deleted by authorized staff');
  res.json({message:'Principal message removed.'});
});

app.get('/api/overview', (req, res) => {
  const students = db.prepare("SELECT class_name, gender FROM student_information WHERE status = 'active'").all();
  const registrations = db.prepare('SELECT * FROM daily_registration WHERE registration_date = ?').all(todayKey());
  const totalStudents = students.length;
  const present = registrations.reduce((n, r) => n + Number(r.present || 0), 0);
  const registeredStudents = registrations.reduce((n, r) => n + Number(r.total_students || 0), 0);
  const attendancePercent = registeredStudents ? Math.round((present / registeredStudents) * 1000) / 10 : 0;
  res.json({ registeredClasses: registrations.length, totalClasses: CLASSES.length, present, totalStudents, registeredStudents, attendancePercent });
});

app.get('/api/classes', (req, res) => res.json({ classes: CLASSES, grades: GRADES }));

app.post('/api/login', (req, res) => {
  const id = cleanText(req.body.staffId, 50);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM staff_users WHERE lower(user_id) = lower(?) ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, id LIMIT 1').get(id, 'Administrator');
  let passwordMatches = Boolean(user && bcrypt.compareSync(password, user.password_hash));

  // Recover the built-in Administrator login if an older SQLite copy has a stale hash.
  // This matches the documented startup default and immediately stores a fresh bcrypt hash.
  if (user && user.active && user.role === ADMINISTRATOR_ROLE && user.user_id.toLowerCase() === 'administrator' && password === DEFAULT_ADMIN_PASSWORD && !passwordMatches) {
    const refreshedHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 12);
    db.prepare('UPDATE staff_users SET user_id=?, name=?, role=?, assigned_class=NULL, active=1, password_hash=? WHERE id=?')
      .run('Administrator', 'Administrator', ADMINISTRATOR_ROLE, refreshedHash, user.id);
    passwordMatches = true;
  }

  if (!user || !user.active || !passwordMatches) {
    audit(id || 'UNKNOWN', 'Failed login', id, '', 'Invalid ID or password');
    return publicError(res, 401, 'Incorrect ID or password.');
  }

  const mode = req.body.mode || 'admin';
  if (mode === 'class' && !ADMIN_ROLES.includes(user.role)) {
    const selectedClass = classFromParts(req.body.grade, req.body.section);
    if (!selectedClass || user.assigned_class !== selectedClass) return publicError(res, 403, 'This account is not assigned to this class.');
  } else if (mode !== 'class' && !ADMIN_ROLES.includes(user.role)) {
    return publicError(res, 403, 'This account does not have school administration access.');
  }

  db.prepare('UPDATE staff_users SET last_login = ? WHERE user_id = ?').run(nowIso(), user.user_id);
  audit(user.user_id, 'Login', user.user_id, user.assigned_class || '', `Role: ${user.role}`);
  setCookie(res, 'school_session', issueSession(user));
  res.json({ user: safeUser(user) });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.school_session) sessions.delete(cookies.school_session);
  if (cookies.db_access) dbAccessSessions.delete(cookies.db_access);
  clearCookie(res, 'school_session');
  clearCookie(res, 'db_access');
  res.json({ ok: true });
});

app.post('/api/students', requireAuth, async (req, res) => {
  const className = normalizeClass(req.body.class_name || req.user.assigned_class);
  if (!ownsClass(req.user, className)) return publicError(res, 403, 'You do not have permission to perform this action.');

  const error = validateStudent({ ...req.body, class_name: className });
  if (error) return publicError(res, 400, error);

  const studentId = cleanText(req.body.student_id, 100);
  if (db.prepare('SELECT 1 FROM student_information WHERE student_id = ?').get(studentId)) return publicError(res, 409, 'This student ID already exists.');
  const registerNumber = req.body.register_number === '' || req.body.register_number === undefined ? null : Number(req.body.register_number);
  if (registerNumber !== null && db.prepare("SELECT 1 FROM student_information WHERE class_name = ? AND register_number = ? AND status = 'active'").get(className, registerNumber)) return publicError(res, 409, 'This register number is already used in this class.');

  const timestamp = nowIso();
  db.prepare(`INSERT INTO student_information
    (student_id,register_number,house,identification_number,full_name,date_of_birth,gender,guardian_name,guardian_phone,address,emergency_contact,notes,class_name,status,date_added,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    studentId,
    registerNumber,
    cleanText(req.body.house, 20),
    cleanText(req.body.identification_number, 100),
    cleanText(req.body.full_name),
    cleanText(req.body.date_of_birth, 10),
    req.body.gender,
    ...Object.values(protectStudentFields({
      guardian_name: cleanText(req.body.guardian_name),
      guardian_phone: cleanText(req.body.guardian_phone, 40),
      address: cleanText(req.body.address),
      emergency_contact: cleanText(req.body.emergency_contact, 100),
      notes: cleanText(req.body.notes, 500)
    })),
    className,
    'active',
    timestamp,
    timestamp
  );

  audit(req.user.user_id, 'Student created', studentId, className);
  res.status(201).json({ student: studentView(db.prepare('SELECT * FROM student_information WHERE student_id = ?').get(studentId)) });
});

app.get('/api/students', requireAuth, (req, res) => {
  const className = normalizeClass(req.query.class || req.user.assigned_class);
  if (!className || (!ownsClass(req.user, className) && !ADMIN_ROLES.includes(req.user.role))) return publicError(res, 403, 'You do not have permission to view this class.');
  const rows = db.prepare("SELECT * FROM student_information WHERE class_name = ? AND status = 'active' ORDER BY student_id COLLATE NOCASE").all(className).map(studentView);
  res.json({ className, students: rows });
});

app.get('/api/students/:studentId', requireAuth, (req, res) => {
  const student = db.prepare('SELECT * FROM student_information WHERE student_id = ?').get(cleanText(req.params.studentId, 100));
  if (!student || (!ownsClass(req.user, student.class_name) && !ADMIN_ROLES.includes(req.user.role))) return publicError(res, 404, 'Student record not found.');
  res.json({ student: studentView(student) });
});

app.put('/api/students/:studentId', requireAuth, async (req, res) => {
  const student = db.prepare('SELECT * FROM student_information WHERE student_id = ?').get(cleanText(req.params.studentId, 100));
  if (!student || !ownsClass(req.user, student.class_name)) return publicError(res, 403, 'You do not have permission to perform this action.');

  const merged = { ...student, ...req.body, class_name: student.class_name };
  const error = validateStudent(merged, true);
  if (error) return publicError(res, 400, error);
  const registerNumber = merged.register_number === '' || merged.register_number === undefined ? null : Number(merged.register_number);
  if (registerNumber !== null && db.prepare("SELECT 1 FROM student_information WHERE class_name = ? AND register_number = ? AND student_id != ? AND status = 'active'").get(student.class_name, registerNumber, student.student_id)) return publicError(res, 409, 'This register number is already used in this class.');

  const timestamp = nowIso();
  db.prepare(`UPDATE student_information SET register_number=?,house=?,identification_number=?,full_name=?,date_of_birth=?,gender=?,guardian_name=?,guardian_phone=?,address=?,emergency_contact=?,notes=?,updated_at=? WHERE student_id=?`)
    .run(
      registerNumber,
      cleanText(merged.house, 20),
      cleanText(merged.identification_number, 100),
      cleanText(merged.full_name),
      cleanText(merged.date_of_birth, 10),
      merged.gender,
      ...Object.values(protectStudentFields({
        guardian_name: cleanText(merged.guardian_name),
        guardian_phone: cleanText(merged.guardian_phone, 40),
        address: cleanText(merged.address),
        emergency_contact: cleanText(merged.emergency_contact, 100),
        notes: cleanText(merged.notes, 500)
      })),
      timestamp,
      student.student_id
    );

  audit(req.user.user_id, 'Student edited', student.student_id, student.class_name);
  res.json({ student: studentView(db.prepare('SELECT * FROM student_information WHERE student_id = ?').get(student.student_id)) });
});

app.post('/api/students/:studentId/transfer', requireAuth, async (req, res) => {
  const student = db.prepare('SELECT * FROM student_information WHERE student_id = ?').get(cleanText(req.params.studentId, 30));
  if (!student || !ownsClass(req.user, student.class_name)) return publicError(res, 403, 'You do not have permission to perform this action.');

  const action = cleanText(req.body.action, 20);
  const newClass = req.body.newClass ? normalizeClass(req.body.newClass) : null;
  if (!['transfer', 'leave', 'inactive'].includes(action)) return publicError(res, 400, 'Please choose a valid student status action.');
  if (action === 'transfer' && !isValidClass(newClass)) return publicError(res, 400, 'Please select a valid destination class.');

  const status = action === 'transfer' ? 'transferred' : action === 'leave' ? 'left' : 'inactive';
  const destination = action === 'transfer' ? newClass : student.class_name;
  const timestamp = nowIso();
  db.prepare('UPDATE student_information SET class_name=?,status=?,updated_at=? WHERE student_id=?').run(destination, status, timestamp, student.student_id);
  audit(req.user.user_id, 'Student transferred', student.student_id, student.class_name, `Action=${action}; New class=${newClass || 'none'}; Reason=${cleanText(req.body.reason, 300)}`);
  res.json({ ok: true, message: action === 'transfer' ? `Student transferred to ${newClass}.` : 'Student status updated.' });
});

app.get('/api/attendance/today', requireAuth, (req, res) => {
  const className = normalizeClass(req.query.class || req.user.assigned_class);
  if (!canReadClass(req.user, className)) return publicError(res, 403, 'You do not have permission to view this class.');

  const students = db.prepare("SELECT * FROM student_information WHERE class_name = ? AND status = 'active' ORDER BY student_id COLLATE NOCASE").all(className).map(studentView);
  const registration = registrationView(db.prepare('SELECT * FROM daily_registration WHERE registration_date = ? AND class_name = ?').get(todayKey(), className));
  const readOnly = !ownsClass(req.user, className);
  res.json({ className, date: todayKey(), students, registration, readOnly });
});

app.post('/api/attendance', requireAuth, (req, res) => {
  const className = normalizeClass(req.body.class_name || req.user.assigned_class);
  if (!TEACHER_ROLES.includes(req.user.role) || !ownsClass(req.user, className)) return publicError(res, 403, 'You do not have permission to submit attendance for this class.');
  if (db.prepare('SELECT 1 FROM daily_registration WHERE registration_date = ? AND class_name = ?').get(todayKey(), className)) return publicError(res, 409, "This class has already submitted today's registration.");

  const activeStudents = db.prepare("SELECT student_id,full_name,gender FROM student_information WHERE class_name = ? AND status = 'active'").all(className);
  const statuses = Array.isArray(req.body.statuses) ? req.body.statuses : [];
  const byId = new Map(statuses.map(item => [cleanText(item.studentId, 30), item.status]));

  if (!activeStudents.length) return publicError(res, 400, 'There are no active students in this class.');
  if (activeStudents.some(student => !['present', 'absent'].includes(byId.get(student.student_id)))) return publicError(res, 400, 'Please mark every student as present or absent.');

  const absentStudents = activeStudents.filter(student => byId.get(student.student_id) === 'absent').map(student => ({ studentId: student.student_id, name: student.full_name }));
  const presentStudents = activeStudents.filter(student => byId.get(student.student_id) === 'present');
  const absent = absentStudents.length;
  const present = presentStudents.length;
  const malePresent = presentStudents.filter(s => s.gender === 'Male').length;
  const femalePresent = presentStudents.filter(s => s.gender === 'Female').length;
  const maleAbsent = absentStudents.filter(s => activeStudents.find(a => a.student_id === s.studentId)?.gender === 'Male').length;
  const femaleAbsent = absentStudents.filter(s => activeStudents.find(a => a.student_id === s.studentId)?.gender === 'Female').length;
  const total = activeStudents.length;

  if (total !== present + absent || present !== malePresent + femalePresent || absent !== maleAbsent + femaleAbsent) return publicError(res, 400, 'Attendance totals are inconsistent. Please review the entries.');

  const timestamp = nowIso();
  db.prepare(`INSERT INTO daily_registration
    (registration_date,submitted_at,class_name,teacher_id,total_students,present,absent,male_present,female_present,male_absent,female_absent,absent_students_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    todayKey(), timestamp, className, req.user.user_id, total, present, absent, malePresent, femalePresent, maleAbsent, femaleAbsent, JSON.stringify(absentStudents)
  );

  audit(req.user.user_id, 'Attendance submitted', todayKey(), className, `Present=${present}; Absent=${absent}`);
  res.status(201).json({ registration: registrationView(db.prepare('SELECT * FROM daily_registration WHERE registration_date = ? AND class_name = ?').get(todayKey(), className)) });
});

app.get('/api/attendance/history', requireAuth, (req, res) => {
  const className = normalizeClass(req.query.class || req.user.assigned_class);
  if (!canReadClass(req.user, className)) return publicError(res, 403, 'You do not have permission to view this class.');
  const rows = db.prepare('SELECT * FROM daily_registration WHERE class_name = ? ORDER BY registration_date DESC LIMIT 90').all(className).map(registrationView);
  res.json({ className, registrations: rows });
});

app.get('/api/admin/dashboard', requireAuth, requireAdmin, (req, res) => {
  const requestedDate = cleanText(req.query.date, 10);
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : todayKey();
  const students = db.prepare("SELECT * FROM student_information WHERE status = 'active'").all();
  const registrations = db.prepare('SELECT * FROM daily_registration WHERE registration_date = ?').all(selectedDate);
  const stats = {
    total: students.length,
    male: students.filter(s => s.gender === 'Male').length,
    female: students.filter(s => s.gender === 'Female').length,
    present: registrations.reduce((n, r) => n + r.present, 0),
    absent: registrations.reduce((n, r) => n + r.absent, 0),
    malePresent: registrations.reduce((n, r) => n + r.male_present, 0),
    femalePresent: registrations.reduce((n, r) => n + r.female_present, 0),
    maleAbsent: registrations.reduce((n, r) => n + r.male_absent, 0),
    femaleAbsent: registrations.reduce((n, r) => n + r.female_absent, 0)
  };
  stats.attendancePercent = stats.total ? Math.round((stats.present / stats.total) * 1000) / 10 : 0;

  const registrationMap = new Map(registrations.map(r => [r.class_name, registrationView(r)]));
  const sections = CLASSES.map(className => {
    const classStudents = students.filter(s => s.class_name === className);
    const registration = registrationMap.get(className) || null;
    return {
      className,
      grade: String(className).match(/^\d+/)?.[0] || '',
      section: className.replace(/^\d+/, ''),
      registration,
      studentCount: classStudents.length,
      attendancePercent: registration && registration.total_students ? Math.round((registration.present / registration.total_students) * 1000) / 10 : null
    };
  });

  res.json({ date: selectedDate, isToday: selectedDate === todayKey(), stats, registeredClasses: registrations.length, totalClasses: CLASSES.length, sections });
});


app.get('/api/staff-registration', requireAuth, requireAdmin, (req, res) => {
  const requestedDate = cleanText(req.query.date, 10);
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : todayKey();
  const rows = db.prepare(`
    SELECT id,registration_date,staff_id,name,role,reported_time,departure_time,registered_by,created_at,updated_at
    FROM staff_registration
    WHERE registration_date = ?
    ORDER BY reported_time, name COLLATE NOCASE
  `).all(selectedDate);
  res.json({ date: selectedDate, registrations: rows, canDelete: ['Principal', ADMINISTRATOR_ROLE].includes(req.user.role) });
});

app.post('/api/staff-registration', (req, res) => {
  const staffId = cleanText(req.body.staffId, 50);
  const name = cleanText(req.body.name, 120);
  const role = cleanText(req.body.role, 40);
  const registrationDate = cleanText(req.body.registrationDate, 10) || todayKey();

  if (!staffId || !name || !STAFF_REGISTRATION_ROLES.includes(role)) {
    return publicError(res, 400, 'Please complete name, ID, and staff role.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(registrationDate)) {
    return publicError(res, 400, 'Please select a valid registration date.');
  }
  const departureTime = cleanText(req.body.departureTime, 5);
  const reportedTime = currentTimeKey();
  if (departureTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) return publicError(res, 400, 'Please enter a valid departure time.');
  if (departureTime && departureTime < reportedTime) return publicError(res, 400, 'Departure time cannot be earlier than the entrance time.');

  const timestamp = nowIso();
  const result = db.prepare(`
    INSERT INTO staff_registration
      (registration_date,staff_id,name,role,reported_time,departure_time,registered_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(registrationDate, staffId, name, role, reportedTime, departureTime || null, 'PUBLIC', timestamp, timestamp);

  audit('PUBLIC', 'Staff registration created', String(result.lastInsertRowid), '', `Staff ID=${staffId}; Role=${role}; Date=${registrationDate}`);
  res.status(201).json({ message: 'Staff registration saved.', id: result.lastInsertRowid });
});

app.post('/api/staff-registration/:id/delete', requireAuth, requireAdmin, (req, res) => {
  if (!['Principal', ADMINISTRATOR_ROLE].includes(req.user.role)) return publicError(res, 403, 'Only an authorized school administrator can delete staff registration records.');
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM staff_registration WHERE id = ?').get(id);
  if (!existing) return publicError(res, 404, 'Staff registration record not found.');
  db.prepare('DELETE FROM staff_registration WHERE id = ?').run(id);
  audit(req.user.user_id, 'Staff registration deleted', String(id), '', `Staff ID=${existing.staff_id}; Date=${existing.registration_date}`);
  res.json({ message: 'Staff registration record deleted.' });
});

app.put('/api/staff-registration/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM staff_registration WHERE id = ?').get(id);
  if (!existing) return publicError(res, 404, 'Staff registration record not found.');

  const departureTime = cleanText(req.body.departureTime, 5);
  if (departureTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) {
    return publicError(res, 400, 'Please enter a valid departure time.');
  }
  if (departureTime && departureTime < existing.reported_time) {
    return publicError(res, 400, 'Departure time cannot be earlier than the reported time.');
  }

  db.prepare('UPDATE staff_registration SET departure_time=?,updated_at=? WHERE id=?').run(departureTime || null, nowIso(), id);
  audit(req.user.user_id, 'Staff departure updated', String(id), '', `Departure=${departureTime || 'not recorded'}`);
  res.json({ message: 'Departure time updated.' });
});

function requireDbAccess(number) {
  return (req, res, next) => {
    const token = parseCookies(req).db_access;
    const access = token && dbAccessSessions.get(token);
    if (!access || access.number !== number || access.expiresAt < Date.now()) return publicError(res, 401, 'Database authentication is required.');
    const user = db.prepare('SELECT * FROM staff_users WHERE user_id = ? AND active = 1').get(access.userId);
    // Administrator can access every database with application credentials only.
    // Principal can access DB/1–DB/3 with application credentials, but DB/4 only
    // after the unlock route has validated the DB/4 password.
    const permitted = number === 4
      ? [ADMINISTRATOR_ROLE, 'Principal'].includes(user?.role)
      : [ADMINISTRATOR_ROLE, 'Principal', 'Vice Principal', 'Assistant Principal'].includes(user?.role);
    if (!user || !permitted) return publicError(res, 403, 'Access Denied.');
    req.dbAccess = access;
    req.dbUser = user;
    next();
  };
}

app.post('/api/db/:number/unlock', (req, res) => {
  const number = Number(req.params.number);
  if (![1, 2, 3, 4].includes(number)) return publicError(res, 404, 'Database not found.');

  // Always verify the submitted ID and application password. An existing app session
  // must never silently unlock a database or bypass DB/4's password for a Principal.
  const id = cleanText(req.body.staffId, 50);
  const user = db.prepare('SELECT * FROM staff_users WHERE lower(user_id) = lower(?)').get(id);
  if (!user || !user.active) {
    audit(id || 'UNKNOWN', 'Failed database login', `DB/${number}`, '', 'Unknown or inactive staff account');
    return publicError(res, 403, 'Access Denied.');
  }
  if (!bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    audit(user.user_id, 'Failed database login', `DB/${number}`, '', 'Invalid staff credentials');
    return publicError(res, 401, 'Incorrect ID or password.');
  }

  const isAdministrator = user.role === ADMINISTRATOR_ROLE;
  const permittedRole = number === 4
    ? (isAdministrator || user.role === 'Principal')
    : ADMIN_ROLES.includes(user.role);
  if (!permittedRole) {
    audit(user.user_id, 'Failed database login', `DB/${number}`, '', 'Role is not permitted');
    return publicError(res, 403, 'Access Denied.');
  }

  // Administrator bypasses all database passwords. Principal bypasses DB/1–DB/3,
  // but must supply DB/4's password. Other authorized admin roles still need the
  // database-specific password.
  const isPrincipal = user.role === 'Principal';
  const requiresDatabasePassword = number === 4
    ? !(isAdministrator)
    : !(isAdministrator || isPrincipal);
  if (requiresDatabasePassword) {
    const storedDbPassword = db.prepare('SELECT password_hash FROM database_passwords WHERE database_number = ?').get(number);
    if (!storedDbPassword || !bcrypt.compareSync(String(req.body.databasePassword || ''), storedDbPassword.password_hash)) {
      audit(user.user_id, 'Failed database login', `DB/${number}`, '', 'Invalid or missing database password');
      return publicError(res, 401, 'Incorrect database password.');
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  dbAccessSessions.set(token, { number, userId: user.user_id, expiresAt: Date.now() + COOKIE_MAX_AGE });
  setCookie(res, 'db_access', token);
  const bypassReason = isAdministrator ? 'Administrator ID/password accepted; database password bypassed' : (isPrincipal && number !== 4 ? 'Principal ID/password accepted; database password bypassed for DB/1–DB/3' : 'Staff and database passwords accepted');
  audit(user.user_id, 'Database login', `DB/${number}`, '', bypassReason);
  res.json({ ok: true, database: number, bypass: !requiresDatabasePassword, specialAccess: false });
});

app.get('/api/db/1/students', requireDbAccess(1), (req, res) => {
  const q = cleanText(req.query.q, 100).toLowerCase();
  const rows = db.prepare(`SELECT student_id,full_name,date_of_birth,gender,guardian_name,guardian_phone,address,emergency_contact,notes,class_name,status,date_added,updated_at FROM student_information ${q ? 'WHERE lower(student_id) LIKE ? OR lower(full_name) LIKE ?' : ''} ORDER BY class_name,full_name COLLATE NOCASE`).all(...(q ? [`%${q}%`, `%${q}%`] : [])).map(studentView);
  res.json({ students: rows });
});

app.get('/api/db/2/registrations', requireDbAccess(2), (req, res) => {
  const rows = db.prepare('SELECT * FROM daily_registration ORDER BY registration_date DESC,class_name LIMIT 500').all().map(registrationView);
  res.json({ registrations: rows });
});

app.get('/api/db/4/credentials', requireDbAccess(4), (req, res) => {
  const credentials = db.prepare('SELECT user_id,name,role,assigned_class,active,created_at,last_login FROM staff_users ORDER BY user_id').all().map(user => ({ ...user, active: Boolean(user.active) }));
  res.json({ credentials });
});

app.get('/api/db/4/database-passwords', requireDbAccess(4), (req, res) => {
  const rows = db.prepare('SELECT database_number,updated_at,updated_by FROM database_passwords ORDER BY database_number').all();
  res.json({ passwords: rows.map(row => ({ databaseNumber: row.database_number, password: '••••••••••', configured: true, updatedAt: row.updated_at, updatedBy: row.updated_by })) });
});

app.put('/api/db/4/database-passwords/:number', requireDbAccess(4), (req, res) => {
  if (req.dbUser.role !== ADMINISTRATOR_ROLE) return publicError(res, 403, 'Only the Administrator can change database passwords.');
  const number = Number(req.params.number);
  const currentPassword = String(req.body.administratorPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const user = db.prepare('SELECT * FROM staff_users WHERE user_id = ? AND active = 1').get(req.dbAccess.userId);
  if (!user || user.role !== ADMINISTRATOR_ROLE || !bcrypt.compareSync(currentPassword, user.password_hash)) return publicError(res, 401, 'Administrator password verification failed.');
  if (![1,2,3,4].includes(number)) return publicError(res, 404, 'Database not found.');
  if (newPassword.length < 12) return publicError(res, 400, 'Use a database password with at least 12 characters.');
  db.prepare('INSERT INTO database_passwords (database_number,password_hash,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(database_number) DO UPDATE SET password_hash=excluded.password_hash,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
    .run(number, bcrypt.hashSync(newPassword, 12), nowIso(), user.user_id);
  audit(user.user_id, 'Database password changed', `DB/${number}`, '', 'Password hash updated; secret not logged');
  res.json({ ok: true, message: `Database ${number} password updated. The new password will be required when unlocking DB/${number}.` });
});

app.get('/api/db/3/users', requireDbAccess(3), (req, res) => {
  const users = db.prepare('SELECT user_id,name,role,assigned_class,active,created_at,last_login FROM staff_users ORDER BY CASE role WHEN \'Principal\' THEN 1 WHEN \'Vice Principal\' THEN 2 WHEN \'Assistant Principal\' THEN 3 WHEN \'Class Teacher\' THEN 4 ELSE 5 END,name').all().map(user => ({ ...user, active: Boolean(user.active) }));
  res.json({ users });
});

app.post('/api/db/3/users', requireDbAccess(3), (req, res) => {
  const actingUser = db.prepare('SELECT * FROM staff_users WHERE user_id = ? AND active = 1').get(req.dbAccess.userId);
  if (!actingUser || !ADMIN_ROLES.includes(actingUser.role)) return publicError(res, 403, 'You do not have permission to perform this action.');

  const role = cleanText(req.body.role, 40);
  const assignedClass = TEACHER_ROLES.includes(role) ? normalizeClass(req.body.assignedClass) : null;
  const requestedUserId = cleanText(req.body.userId, 50);
  const userId = TEACHER_ROLES.includes(role) && !requestedUserId && assignedClass ? buildTeacherUserId(role, assignedClass, CURRENT_SCHOOL_YEAR) : requestedUserId;
  const name = cleanText(req.body.name, 120);
  const active = req.body.active === false || req.body.active === 'false' ? 0 : 1;
  const password = String(req.body.password || '');

  if (!/^[A-Za-z0-9-]{3,50}$/.test(userId) || !name || ![...ADMIN_ROLES, ...TEACHER_ROLES].includes(role)) return publicError(res, 400, 'Enter a valid ID, name, and role.');
  if (TEACHER_ROLES.includes(role) && !isValidClass(assignedClass)) return publicError(res, 400, 'Teacher accounts require a valid assigned class.');

  const existing = db.prepare('SELECT * FROM staff_users WHERE user_id = ?').get(userId);
  if (!existing && password.length < 8) return publicError(res, 400, 'New staff users need a password of at least 8 characters.');

  if (existing) {
    db.prepare('UPDATE staff_users SET name=?,role=?,assigned_class=?,active=?' + (password ? ',password_hash=?' : '') + ' WHERE user_id=?')
      .run(...(password ? [name, role, assignedClass, active, bcrypt.hashSync(password, 12), userId] : [name, role, assignedClass, active, userId]));
    audit(actingUser.user_id, 'Administrative action', userId, assignedClass || '', 'Staff user updated');
  } else {
    db.prepare('INSERT INTO staff_users (user_id,name,role,assigned_class,active,password_hash,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(userId, name, role, assignedClass, active, bcrypt.hashSync(password, 12), nowIso());
    audit(actingUser.user_id, 'Administrative action', userId, assignedClass || '', 'Staff user created');
  }

  res.json({ ok: true, message: existing ? 'Staff user updated.' : 'Staff user created.' });
});

app.post('/api/db/3/users/delete', requireDbAccess(3), (req, res) => {
  const actingUser = db.prepare('SELECT * FROM staff_users WHERE user_id = ? AND active = 1').get(req.dbAccess.userId);
  if (!actingUser || !['Principal', ADMINISTRATOR_ROLE].includes(actingUser.role)) return publicError(res, 403, 'Only an authorized school administrator can delete staff accounts.');

  const userId = cleanText(req.body.userId, 50);
  if (!userId) return publicError(res, 400, 'Enter a valid staff ID to delete.');
  if (userId === actingUser.user_id) return publicError(res, 400, 'The Principal cannot delete their own account.');

  const target = db.prepare('SELECT * FROM staff_users WHERE user_id = ?').get(userId);
  if (!target) return publicError(res, 404, 'Staff user not found.');

  db.prepare('DELETE FROM staff_users WHERE user_id = ?').run(userId);
  audit(actingUser.user_id, 'Administrative action', userId, target.assigned_class || '', 'Staff user deleted');
  res.json({ ok: true, message: 'Staff user deleted.' });
});

app.get('/api/audit', requireAuth, requireAdmin, (req, res) => res.json({ audit: db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 250').all(), canDelete: ['Principal', ADMINISTRATOR_ROLE].includes(req.user.role) }));

app.post('/api/audit/delete', requireAuth, requireAdmin, (req, res) => {
  if (!['Principal', ADMINISTRATOR_ROLE].includes(req.user.role)) return publicError(res, 403, 'Only an authorized school administrator can delete audit log data.');
  const removed = db.prepare('DELETE FROM audit_log').run();
  audit(req.user.user_id, 'Audit log cleared', `${removed.changes} records`, '', 'Audit data deleted by the Principal');
  res.json({ message: 'Audit log data deleted.' });
});

app.get('/api/export/students.csv', requireDbAccess(1), (req, res) => {
  const rows = db.prepare('SELECT student_id,full_name,date_of_birth,gender,class_name,status,guardian_name,guardian_phone FROM student_information ORDER BY class_name,full_name').all();
  const csv = [['Student ID','Name','DOB','Gender','Class','Status','Guardian','Guardian Phone'], ...rows.map(r => [r.student_id,r.full_name,r.date_of_birth,r.gender,r.class_name,r.status,r.guardian_name,r.guardian_phone])]
    .map(row => row.map(value => `"${String(value ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="student-information.csv"');
  res.send(csv);
});

app.get('/api/export/registrations.csv', requireDbAccess(2), (req, res) => {
  const rows = db.prepare('SELECT registration_date,class_name,teacher_id,total_students,present,absent,male_present,female_present,male_absent,female_absent,submitted_at FROM daily_registration ORDER BY registration_date DESC,class_name').all();
  const csv = [['Date','Class','Submitted by','Total','Present','Absent','Male Present','Female Present','Male Absent','Female Absent','Submitted at'], ...rows.map(r => [r.registration_date,r.class_name,r.teacher_id,r.total_students,r.present,r.absent,r.male_present,r.female_present,r.male_absent,r.female_absent,r.submitted_at])]
    .map(row => row.map(value => `"${String(value ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="daily-registration.csv"');
  res.send(csv);
});

app.get('/DB/1', (req, res) => res.sendFile(path.join(ROOT, 'public', 'db.html')));
app.get('/DB/2', (req, res) => res.sendFile(path.join(ROOT, 'public', 'db.html')));
app.get('/DB/3', (req, res) => res.sendFile(path.join(ROOT, 'public', 'db.html')));
app.get('/DB/4', (req, res) => res.sendFile(path.join(ROOT, 'public', 'db.html')));
app.get('/DB/5', (req, res) => res.sendFile(path.join(ROOT, 'public', 'db.html')));
app.get('/DB/6', (req, res) => res.sendFile(path.join(ROOT, 'public', 'db.html')));
app.get('/login', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  publicError(res, 500, 'The request could not be completed.');
});

function start(port = PORT) {
  const preferredPort = Number(port) || 3000;
  const candidatePorts = Array.from(new Set([
    preferredPort,
    ...Array.from({ length: 20 }, (_, index) => preferredPort + index + 1)
  ]));

  let currentIndex = 0;

  function attemptListen() {
    const candidatePort = candidatePorts[currentIndex];
    const server = app.listen(candidatePort, () => {
      console.log('========================================');
      console.log('DIGITAL SCHOOL REGISTRATION SYSTEM');
      console.log('========================================');
      console.log(`Main UI:   http://localhost:${candidatePort}/`);
      console.log(`Database 1: http://localhost:${candidatePort}/DB/1`);
      console.log(`Database 2: http://localhost:${candidatePort}/DB/2`);
      console.log(`Database 3: http://localhost:${candidatePort}/DB/3`);
      console.log(`Database 4: http://localhost:${candidatePort}/DB/4`);
      console.log(`Database 5 (absence reasons): http://localhost:${candidatePort}/DB/5`);
      console.log(`Database 6 (principal messages): http://localhost:${candidatePort}/DB/6`);
      console.log(`Classes:   ${CLASSES.length}`);
      console.log('Server:    RUNNING');
      console.log('========================================');
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        if (currentIndex < candidatePorts.length - 1) {
          console.warn(`Port ${candidatePort} is already in use. Trying ${candidatePorts[currentIndex + 1]}...`);
          currentIndex += 1;
          server.close(() => attemptListen());
          return;
        }

        console.error(`Unable to start server. Ports ${candidatePorts.join(', ')} are all in use.`);
        process.exitCode = 1;
        return;
      }

      console.error(`Server startup failed on port ${candidatePort}:`, error.message);
      process.exitCode = 1;
    });
  }

  attemptListen();
}

if (require.main === module) start();
module.exports = { app, db, CLASSES, cleanup, normalizeClass, buildTeacherUserId, start };
