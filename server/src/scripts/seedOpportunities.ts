/**
 * Creates a realistic set of upcoming volunteer opportunities that real
 * students can actually qualify for.
 *
 * The existing sample event pins every activity to one fixed date and four
 * narrow skills, so most students match nothing. This builds the opportunity
 * set from the availability students have actually saved: for each student
 * with a complete profile it places a shift inside a window they said they are
 * free, sized within their daily hours limit, requiring a skill they already
 * list. It also adds open-to-all shifts that need no particular skill.
 *
 * Everything is flagged `isSampleData` so the interface labels it, and
 * `npm run seed:opportunities -- --clean` removes exactly what this created.
 * Refuses to run with NODE_ENV=production.
 */
import { localToday, skillKey, toInstant } from '../catalog.js';
import { loadConfig } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { Activity, Assignment, Event, User } from '../models.js';
import { checkVolunteer, loadVolunteers } from '../services/eligibility.js';

const EVENT_NAME = '[DEV SAMPLE] Campus Volunteering Drive';

const config = loadConfig();
if (config.isProduction) throw new Error('Refusing to run with NODE_ENV=production.');
if (!config.mongoUri) throw new Error('MONGODB_URI is not set. See server/.env.example.');
const offset = config.utcOffsetMinutes;
const clean = process.argv.includes('--clean');

const addMinutes = (time: string, minutes: number) => {
  const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

await connectDatabase(config.mongoUri);
try {
  // ------------------------------------------------------------- clean up
  const existing = await Event.findOne({ name: EVENT_NAME });
  if (existing) {
    const activityIds = await Activity.find({ eventId: existing._id }).distinct('_id');
    await Assignment.deleteMany({ activityId: { $in: activityIds } });
    await Activity.deleteMany({ eventId: existing._id });
    await existing.deleteOne();
    console.log(`Removed the previous "${EVENT_NAME}" and its activities.`);
  }
  if (clean) {
    console.log('Done (--clean): nothing was created.');
    process.exit(0);
  }

  const faculty = await User.findOne({ role: 'faculty' });
  if (!faculty) throw new Error('No faculty account exists to own the event. Run `npm run seed:dev` first.');

  const today = localToday(offset);
  const volunteers = [...(await loadVolunteers()).values()].filter((v) => v.profileComplete);
  if (!volunteers.length) throw new Error('No students have completed a volunteer profile yet.');

  interface Planned {
    name: string;
    date: string;
    startTime: string;
    endTime: string;
    requiredSkills: string[];
    activityType: string | null;
    requiredCount: number;
    description: string;
    minPriorEvents?: number;
  }
  const planned: Planned[] = [];
  const seen = new Set<string>();

  /**
   * Roughly how many students should end up with something they qualify for.
   * Deliberately not everyone: the "Not Eligible" explanations and the
   * vacancy-discovery popup only mean anything if some students genuinely do
   * not qualify yet, which is also what a real term looks like.
   */
  const ELIGIBLE_SHARE = 0.6;
  // Richest profiles first, then by username for a stable order across runs.
  // This mirrors how the product actually behaves — a student who listed more
  // skills and wider availability matches more roles — so the students left
  // without a match are the ones with the thinnest profiles, which is exactly
  // who the "update your profile" guidance is aimed at.
  const ordered = [...volunteers].sort(
    (a, b) =>
      b.skills.length - a.skills.length ||
      b.availability.length - a.availability.length ||
      (a.user.username as string).localeCompare(b.user.username as string),
  );

  // Other events already make some students eligible, so the target has to be
  // measured against the whole app rather than this event alone — otherwise
  // the shifts added here stack on top and everyone ends up eligible again.
  const otherActivities = await Activity.find({
    eventId: { $in: (await Event.find({ status: 'published' })).map((e) => e._id) },
    status: 'open',
    endAt: { $gt: new Date() },
  });
  const alreadyEligible = new Set(ordered.filter((v) => otherActivities.some((a) => checkVolunteer(v, a).length === 0)).map((v) => v.id));

  const target = Math.max(1, Math.round(ordered.length * ELIGIBLE_SHARE));
  // At least one shift is always added: a student with the most complete
  // profile in the system having nothing to volunteer for is the clearest sign
  // the opportunity set is wrong, not that the student is unsuitable.
  const toAdd = Math.max(1, target - alreadyEligible.size);
  // Only students who have nothing yet are given a shift, richest profile first.
  const needing = ordered.filter((v) => !alreadyEligible.has(v.id));
  const covered = needing.slice(0, toAdd);
  const uncovered = needing.slice(covered.length);
  if (alreadyEligible.size >= target) {
    console.log(
      `Note: ${alreadyEligible.size} students already qualify for existing events (at or above the ~${Math.round(ELIGIBLE_SHARE * 100)}% target), ` +
        `so only the most complete profile still without an option is given one.`,
    );
  }

  // A shift for each covered student, inside a window they are genuinely free,
  // short enough for their daily limit, needing a skill they already have.
  for (const v of covered) {
    const slot = v.availability.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!slot) continue;

    const windowMinutes = minutesOf(slot.endTime) - minutesOf(slot.startTime);
    const capMinutes = Math.min(120, windowMinutes, (v.maxHoursPerDay ?? 2) * 60);
    if (capMinutes < 60) continue; // too tight to place a sensible shift
    const startTime = slot.startTime;
    const endTime = addMinutes(startTime, capMinutes);

    // Two skills, not one: a single common skill like "Communication" would
    // also fit students meant to be left without a match, which would quietly
    // make everyone eligible again.
    const skills = v.skills.slice(0, 2);
    const skill = skills[0];
    const preference = v.preferences[0] ?? null;
    // The same skill set on the same date is one shift, not several identical ones.
    const key = `${slot.date}|${skills.map(skillKey).sort().join('+')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // "Technical Support support" reads badly; only add a noun when the skill
    // is not already one. Dates keep same-skill shifts distinguishable.
    const roleName = !skill
      ? 'General volunteering'
      : /\b(support|management|relations|aid|media)\b/i.test(skill)
        ? `${skill} team`
        : `${skill} support`;

    planned.push({
      name: roleName,
      date: slot.date,
      startTime,
      endTime,
      requiredSkills: skills,
      activityType: preference,
      requiredCount: 3,
      description: skill ? `Help the team with ${skills.join(' and ').toLowerCase()} during the drive.` : 'General help during the drive; no specific skill needed.',
    });
  }

  /** Mirrors the mandatory rules closely enough to tell whether a planned shift would suit this student. */
  const fits = (v: (typeof volunteers)[number], p: Planned) => {
    if (p.requiredSkills.some((s) => !v.skillKeys.has(skillKey(s)))) return false;
    const durationHours = (minutesOf(p.endTime) - minutesOf(p.startTime)) / 60;
    if (v.maxHoursPerDay !== null && durationHours > v.maxHoursPerDay) return false;
    return v.availability.some((s) => s.date === p.date && minutesOf(s.startTime) <= minutesOf(p.startTime) && minutesOf(s.endTime) >= minutesOf(p.endTime));
  };

  // De-duplication can leave a covered student whose window differs from the
  // shift that was kept. Give them one open-to-all shift in their own window.
  for (const v of covered) {
    if (planned.some((p) => fits(v, p))) continue;
    const slot = v.availability.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!slot) continue;
    const capMinutes = Math.min(120, minutesOf(slot.endTime) - minutesOf(slot.startTime), (v.maxHoursPerDay ?? 2) * 60);
    if (capMinutes < 60) continue;
    planned.push({
      name: 'Helping hands (open to all)',
      date: slot.date,
      startTime: slot.startTime,
      endTime: addMinutes(slot.startTime, capMinutes),
      requiredSkills: [],
      activityType: null,
      requiredCount: 5,
      description: 'An hour or two of general help. No particular skill is required.',
    });
  }

  // Stretch roles with real vacancies that nobody here qualifies for yet.
  // These are what the discovery popup offers as "Explore Opportunity": they
  // give the students who do not qualify something concrete to aim at.
  const firstDate = planned.length ? planned.map((p) => p.date).sort()[0] : today;
  planned.push(
    {
      name: 'Stage crew (experienced)',
      date: firstDate,
      startTime: '14:00',
      endTime: '17:00',
      requiredSkills: ['Stage Management'],
      activityType: 'Stage Management',
      requiredCount: 4,
      description: 'Set changes and backstage cues. Needs stage management and some volunteering behind you.',
      minPriorEvents: 2,
    },
    {
      name: 'First aid point',
      date: firstDate,
      startTime: '09:00',
      endTime: '13:00',
      requiredSkills: ['First Aid'],
      activityType: 'First Aid',
      requiredCount: 2,
      description: 'Staff the first aid desk alongside the campus medical team.',
    },
  );

  const dates = planned.map((p) => p.date).sort();
  const event = await Event.create({
    name: EVENT_NAME,
    description: 'Rolling volunteering opportunities built around when students said they are available.',
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    venue: 'Across campus',
    status: 'published',
    createdBy: faculty._id,
    isSampleData: true,
  });

  await Activity.create(
    planned.map((p) => ({
      eventId: event._id,
      name: p.name,
      description: p.description,
      activityType: p.activityType,
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      startAt: toInstant(p.date, p.startTime, offset),
      endAt: toInstant(p.date, p.endTime, offset),
      location: 'Main Block',
      requiredSkills: p.requiredSkills,
      requiredSkillKeys: p.requiredSkills.map(skillKey),
      requiredCount: p.requiredCount,
      minPriorEvents: p.minPriorEvents ?? 0,
      status: 'open',
    })),
  );
  console.log(`Created "${EVENT_NAME}" with ${planned.length} activities from ${dates[0]} to ${dates[dates.length - 1]}.`);

  // ------------------------------------------------- verify, do not assume
  // Measured across every open activity in the app, which is what students see.
  const allOpen = await Activity.find({
    eventId: { $in: (await Event.find({ status: 'published' })).map((e) => e._id) },
    status: 'open',
    endAt: { $gt: new Date() },
  }).sort({ startAt: 1 });
  const fresh = await loadVolunteers();
  console.log('\nEligible options per student (all published events):');
  let withNone = 0;
  for (const v of ordered) {
    const me = fresh.get(v.id)!;
    const eligible = allOpen.filter((a) => checkVolunteer(me, a).length === 0);
    if (!eligible.length) withNone++;
    console.log(
      `  ${eligible.length ? `${eligible.length} eligible` : 'none      '}  ${me.user.fullName} (${me.user.username})` +
        `${eligible.length ? ` -> ${eligible.map((a) => a.name).join(', ')}` : ''}`,
    );
  }
  const withSome = ordered.length - withNone;
  console.log(`\n${withSome} of ${ordered.length} students have an eligible option; ${withNone} do not (they get the vacancy-discovery popup).`);
  console.log(`Targeted ~${Math.round(ELIGIBLE_SHARE * 100)}% eligible — adjust ELIGIBLE_SHARE in this script to change the mix.`);
  if (uncovered.length) console.log(`Intentionally left without a tailored shift: ${uncovered.map((v) => v.user.username).join(', ')}`);
} finally {
  await disconnectDatabase();
}
