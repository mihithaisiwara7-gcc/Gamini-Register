# Test Results

Test date: 2026-10-27

Static syntax checks passed for `server.js`, `public/app.js`, and `scripts/smoke-test.js` using Node.js 22.16.0. Full runtime smoke tests were not run in this environment because npm dependency installation timed out; run `npm install` and then `npm start` followed by `node scripts/smoke-test.js` locally.

Implemented in this update:

- Removed Neon/PostgreSQL connection code and the `pg` dependency; SQLite remains the sole application database.
- Added DB/5 for absence reasons and DB/6 for principal messages. Both APIs require a logged-in Principal or Administrator.
- Added one-reason-per-student-per-day uniqueness, including deduplication of legacy duplicate rows during migration.
- Added an edit-reason action and Unicode-friendly reason storage.
- Added individual manual deletion for principal messages.
- Added daily midnight and weekly Sunday-midnight cleanup using Asia/Colombo time, with startup and periodic fallback cleanup.
- Preserved the supplied `data/school.sqlite` file in the archive; database migrations run when the server starts.
