# VOLUNTRIX

**The right people. The right event. The right time.**

A smart event volunteer allocation system: registration and login, volunteer
profiles, events and activities, automatic allocation with approval,
conflict detection, schedules, analytics, and faculty-controlled organizer
promotion. AI features are not built.

- `server/` — Express + TypeScript API, MongoDB (Mongoose), tests
- `client/` — React + Vite + TypeScript interface

## Try it in two minutes (no accounts or database needed)

```bash
npm run setup        # installs server and client dependencies
npm run demo:api     # terminal 1: API + throwaway in-memory MongoDB + sample accounts
npm run client       # terminal 2: http://localhost:5173
```

The demo prints its sample accounts. All use the password `Voluntrix@123`:

| Sign in as | Username          | Notes                                                    |
| ---------- | ----------------- | -------------------------------------------------------- |
| Student    | `student`         | sample history, complete profile, open promotion request |
| Student    | `student.new`     | profile not completed — lands on profile setup           |
| Student    | `asha`, `kiran`, `meera`, `rahul` | complete profiles, available for the sample event |
| Faculty    | `faculty`         | manages events, allocation and promotions                |

To see the main flow: sign in as `faculty`, open **Events → [DEV SAMPLE]
Freshers Day**, press **Generate allocation**, then **Confirm all pending**.
One activity (Stage Crew) is deliberately impossible to staff, to show a
shortage report.

Demo data lives in memory and disappears when the API stops. The sample
events are flagged `isSampleData` and shown as “sample” in the interface; they
are not real volunteering history.

## Volunteer allocation

**Volunteer profile** — after first sign-in a student completes a profile:
department, semester, skills (suggested or custom, de-duplicated regardless
of capitalisation), availability slots, activity preferences and a maximum
number of hours per day. It is stored on the student's existing profile
document, so there is one per student.

**Events and activities** — faculty (and promoted organizers, for events they
created) create events and add activities with a time, location, required
skills, nice-to-have skills, headcount and optional experience requirement.

**Allocation** — `server/src/services/allocation.ts`. Mandatory rules live in
one place, `server/src/services/eligibility.ts`. Automatic allocation and
confirmation require:

- a complete volunteer profile
- availability covering the whole activity (consecutive slots are combined)
- has every required skill and any required experience
- no overlap with another pending or confirmed assignment
- stays within the volunteer's maximum hours for that day
- the activity still has a free position

Students may also request an open position when their schedule and every
other requirement match but they lack one or more required skills. The request
stays pending and cannot be confirmed until they add those skills; the server
checks again at confirmation. Availability is checked before skill matching
so an unavailable activity is never offered as requestable.

Volunteers who pass are ranked by a 0–100 score
(`server/src/services/scoring.ts`: preference match 30, nice-to-have skills
20, experience 15, lighter workload 20, spare hours 15). The score only orders
eligible volunteers; it can never make an ineligible one assignable.
Activities with the fewest eligible volunteers are filled first. Where there
are not enough people the position stays vacant and the report says why.

Generated assignments and student requests are **pending** until an organizer
confirms them. Confirming, assigning manually and replacing a volunteer all
re-check the applicable rules on the server at that moment. Regenerating never
touches confirmed assignments. Times are stored as real instants using one
institution-wide offset (`APP_UTC_OFFSET_MINUTES`, default India +330).

**After the activity** — the organizer records attendance and optional
feedback on each confirmed assignment. That record is what faculty see as
evidence when reviewing an organizer promotion.

Styling is hand-written CSS (`client/src/styles.css`), not Tailwind, and the
charts are plain HTML/CSS bars rather than Recharts, to keep the existing
design system and avoid new dependencies.

## Real setup

1. **MongoDB Atlas** — create a cluster and database user, allow your IP, and
   copy the connection string. A replica set is required because promotions
   use transactions (every Atlas cluster is one; a bare local `mongod` is not).
2. **Supabase** (recommended for anything beyond local development) — create a
   project, then:
   - copy the project URL and the **service-role** key (server only — never
     put it in `client/`),
   - create a **private** Storage bucket named `profile-photos`,
   - under Authentication, disable public sign-ups; accounts are only created
     by this backend.
3. Copy `server/.env.example` to `server/.env` and fill in `MONGODB_URI`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `FACULTY_EMAIL_DOMAINS`
   (for example `yourcollege.edu`). Faculty registration is refused while
   `FACULTY_EMAIL_DOMAINS` is empty.
4. **Set `FACULTY_ID_ALLOWLIST`** to your real faculty IDs (comma separated).
   There is no approval step, so this list is what stops a student from
   registering as faculty with a made-up ID and institutional-looking email.
   Without it, anyone who knows the email domain can become faculty.
5. Run `npm run api` and `npm run client`.

If the Supabase variables are left empty, the server falls back to local
development drivers: bcrypt password hashes in a separate `credentials`
collection and photos on local disk (`server/uploads/`). Passwords are never
stored in plaintext in either mode.

`npm run seed:dev` (in `server/`) loads the same sample accounts as the demo
into your configured database. It refuses to run with `NODE_ENV=production`.

## How it works

**Roles** — `student`, `faculty`, `organizer`. There is no administrator
role. An account has exactly one role, stored in MongoDB and read from the
database on every request.

**Registration** — students become `student` immediately. Faculty become
`faculty` immediately if their email is on an allowed institutional domain and
their faculty ID is valid (and on `FACULTY_ID_ALLOWLIST` when that is set).
Nobody can register as an organizer. To disable a faculty account, set
`verificationStatus` to `rejected` on its `facultyProfiles` document or
`accountStatus` to `suspended` on the user.

**Login** — one form; the chosen role is only a requested mode. The backend
checks the username and password, then compares the requested role with the
account's stored role and refuses a mismatch. Sessions are opaque random
tokens in an `httpOnly`, `SameSite=Lax` cookie; only a SHA-256 hash is stored.

**Organizer promotion** — a student asks (or a verified faculty member
nominates by USN). A verified faculty member reviews the student's attendance
and feedback records and approves, rejects, or asks for further review, always
with a reason. Approval changes the role on the *existing* account in one
transaction together with the request status, a `roleAuditLogs` entry and a
notification; if any part fails, nothing changes. The student then signs in
through **Organizer** with the same username and password. Their student
profile and history stay attached to the account.

**Promotion policy** — `server/src/config/promotionPolicy.ts`, configurable
through `PROMOTION_*` environment variables (minimum attended events,
attendance rate, feedback count, re-application cooldown). The policy only
gates approval; it never approves or rejects on its own, and there is no
rating threshold.

## API

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/auth/register/student`, `/api/auth/register/faculty` | public (rate limited) |
| POST | `/api/auth/login`, `/api/auth/logout` | public (rate limited) |
| GET / PATCH | `/api/me` | signed in (PATCH: `fullName`, `phone` only) |
| PUT | `/api/me/photo` | signed in |
| GET | `/api/users/:id/photo` | owner, authorized faculty |
| GET / POST | `/api/notifications`, `/api/notifications/:id/read` | owner |
| POST | `/api/promotion-requests` | student (self) or verified faculty (by USN) |
| GET | `/api/faculty/promotion-requests`, `/:id` | verified faculty |
| POST | `/api/faculty/promotion-requests/:id/decision` | verified faculty |
| GET | `/api/organizer/overview` | organizer |
| GET / PUT | `/api/volunteer-profile` | own profile (PUT: students) |
| GET | `/api/student/dashboard`, `/activities`, `/assignments` | student, own data only |
| POST | `/api/student/assignments/:id/cancel` | the assigned student |
| GET / POST / PUT / DELETE | `/api/manage/events`, `/api/manage/events/:id` | faculty; organizer for own events |
| POST / PUT / DELETE | `/api/manage/events/:id/activities`, `/api/manage/activities/:id` | event managers |
| POST | `/api/manage/events/:id/allocate` | event managers |
| GET | `/api/manage/activities/:id/candidates` | event managers |
| POST | `/api/manage/activities/:id/assignments` | event managers (manual assign) |
| GET | `/api/manage/assignments` | event managers (filters: event, activity, status, date, volunteer) |
| POST | `/api/manage/assignments/:id/confirm`, `/reject`, `/cancel`, `/replace`, `/outcome` | event managers |
| POST | `/api/manage/events/:id/assignments/confirm-all` | event managers |
| GET | `/api/manage/volunteers`, `/api/manage/analytics` | faculty, organizers |

Errors are `{ error, code, details? }` with 400 / 401 / 403 / 404 / 409 / 422 / 429.

## Tests

```bash
npm test
```

Runs the API tests against an in-memory MongoDB replica set (the first run
downloads a MongoDB binary). They cover registration and validation, faculty
credential checks, login role mismatch, sessions, photo upload checks, promotion
approval / rejection / further review, duplicate and concurrent requests,
privilege escalation attempts, audit logging and transaction rollback.
