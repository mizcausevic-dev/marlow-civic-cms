import { migrate, openDatabase } from './db.ts';

const databasePath = process.env.DATABASE_PATH ?? './data/cms.sqlite';
const db = openDatabase(databasePath);
migrate(db);
db.close();
console.log(JSON.stringify({ event: 'migrated', databasePath }));
