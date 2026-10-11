/** Prints every student's eligibility against every open activity, with reasons. */
import { loadConfig } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { Activity, Event } from '../models.js';
import { checkVolunteer, loadVolunteers } from '../services/eligibility.js';

const { mongoUri } = loadConfig();
if (!mongoUri) throw new Error('MONGODB_URI is not set.');

await connectDatabase(mongoUri);
try {
  const now = new Date();
  const events = await Event.find({ status: 'published' });
  const eventById = new Map(events.map((e) => [e.id as string, e]));
  const activities = await Activity.find({ eventId: { $in: events.map((e) => e._id) }, status: 'open', endAt: { $gt: now } }).sort({ startAt: 1 });

  console.log(`\n=== OPEN UPCOMING ACTIVITIES (${activities.length}) ===`);
  for (const a of activities) {
    console.log(
      `• ${a.name} [${eventById.get(String(a.eventId))?.name}] ${a.date} ${a.startTime}-${a.endTime}` +
        ` | requires: ${a.requiredSkills.join(', ') || '(none)'}` +
        ` | minPrior=${a.minPriorEvents ?? 0} testPass=${Boolean(a.requireTestPass)}`,
    );
  }

  const volunteers = [...(await loadVolunteers()).values()];
  console.log(`\n=== STUDENTS (${volunteers.length}) ===`);
  for (const v of volunteers) {
    const slots = v.availability.map((s) => `${s.date} ${s.startTime}-${s.endTime}`).join('; ') || '(none)';
    console.log(`\n${v.user.fullName} (${v.user.username})`);
    console.log(`   complete=${v.profileComplete} maxHours=${v.maxHoursPerDay} attended=${v.attendedCount}`);
    console.log(`   skills: ${v.skills.join(', ') || '(none)'}`);
    console.log(`   prefs : ${v.preferences.join(', ') || '(none)'}`);
    console.log(`   avail : ${slots}`);
    for (const a of activities) {
      const violations = checkVolunteer(v, a);
      const mark = violations.length === 0 ? 'ELIGIBLE  ' : 'not elig. ';
      console.log(`     ${mark} ${a.name}${violations.length ? ` -> ${violations.map((x) => x.message).join('; ')}` : ''}`);
    }
  }
} finally {
  await disconnectDatabase();
}
