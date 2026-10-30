const { cleanup } = require('../server');

const result = cleanup();
console.log(`Cleanup complete. Deleted ${result.students} expired student records, ${result.registrations} expired daily registrations, ${result.absenceReasons} expired absence reasons, and ${result.principalMessages} expired principal messages.`);
process.exit(0);
