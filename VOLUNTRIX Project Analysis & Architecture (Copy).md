# VOLUNTRIX — Project Analysis & Architecture

"The right people. The right event. The right time."

## 1. Your Understanding of VOLUNTRIX

**VOLUNTRIX is an AI-powered campus volunteer allocation platform that solves the logistical and fairness problems inherent in manual event staffing.**

Rather than relying on spreadsheets and manual coordination, VOLUNTRIX creates a structured marketplace where:

- **Event organizers** define volunteer roles with clear eligibility criteria and staffing targets
- **Students** build discoverable profiles showcasing skills, interests, and availability
- **An allocation engine** matches students to roles based on both mandatory constraints and intelligent ranking
- **AI assists** with event planning and personalized opportunity discovery

**Core value:** By centralizing volunteer data and automating the eligibility → ranking → allocation flow, VOLUNTRIX reduces organizer friction, ensures fair opportunity distribution (not always the same experienced students), and helps students find roles that match their development goals.

**Critical constraint:** All volunteer selection must remain explainable and auditable. AI suggests, humans decide. Mandatory eligibility rules are never overridden by AI rankings.

## 2. User Roles and Permissions

| Role | Key Capabilities | Data Access |
| --- | --- | --- |
| **Student / Volunteer** | • Manage own profile (skills, interests, availability) • Browse published events • Apply for roles • Track application status • View confirmed assignments • Receive recommendations | Own profile, own applications, own assignments, own notifications. **Cannot see:** other students' data, organizer-internal rankings, confidential feedback |
| **Event Organizer** | • Create events they organize • Define roles and staffing • Review applications • Allocate volunteers • Record attendance • Collect feedback | Events they manage, applications to those events, assignments, feedback. **Cannot see:** events they don't manage, other organizers' confidential data |
| **Administrator** | • Manage user roles • Handle disputes • Monitor platform health • View platform analytics | Access as needed for oversight. Must follow least-privilege principle. |

**⚠️ Critical Permission Rule:** Authorization must be enforced on the backend for every request. A user cannot access private data or modify another organizer's events by manipulating URLs, request IDs, or API parameters. Every GET/POST/PUT/DELETE must verify the authenticated user has explicit permission to that resource.

## 3. Functional Modules & Their Interactions

STUDENT FLOW: Profile → Browse Events → Receive Recommendations → Apply → Track Status → Confirm Assignment ORGANIZER FLOW: Create Event → Define Roles → Review Applications → Allocate (with AI help) → Manage → Collect Feedback ALLOCATION ENGINE (Core): Eligibility Check → Candidate Ranking → Capacity Constraints → Organizer Review → Confirmation SHARED DATA: Users ← → VolunteerProfiles Events ← → EventRoles ← → Applications ← → Assignments Notifications (event-driven) Feedback (post-event)

### The 12 Modules (Interdependencies)

1. **Authentication & Profiles** — Foundation. Required for all other modules.
   - Stores user identity, role, credentials
   - Student profiles extend users with skills, interests, availability
2. **Event Creation & Management** — Depends on Authentication. Organizers create events with metadata.
   - Connects to Roles (one event → many roles)
   - Defines application deadlines and eligibility rules
3. **Role Definition & Staffing** — Depends on Events. Roles are defined within events.
   - Stores mandatory and preferred requirements
   - AI Co-Pilot assists here
4. **Applications & Eligibility** — Depends on Roles. Students apply; eligibility rules are checked.
   - Tracks application state (submitted, under review, selected, rejected, etc.)
   - Foundation for allocation
5. **Smart Allocation** — Depends on Applications + Scheduling. The engine that ranks and assigns.
   - Eligibility filtering (mandatory constraints)
   - Candidate ranking (skills, interests, fairness)
   - Capacity-aware slot filling
   - Organizer review before confirmation
6. **AI Event Co-Pilot** — Supports Event Creation. Suggests roles, staffing levels, responsibilities.
   - Output must be validated by organizer before saving
7. **AI Volunteer Guide** — Supports Profiles. Recommends events and roles.
   - Respects eligibility, deadlines, availability
   - Explains why a role fits
8. **Scheduling & Conflict Management** — Runs through Applications and Assignments.
   - Detects conflicts between confirmed assignments
   - Prevents double-booking
9. **Notifications & Coordination** — Event-driven across all modules.
   - Status changes, selections, confirmations, reminders
10. **Attendance & Feedback** — Post-event. Records participation and feedback.
    - Informs future recommendations and fairness algorithms
11. **Maps & Location** — Optional for MVP. Event venue information.
    - Can be added later without disrupting core flows
12. **Organizer Dashboard** — Aggregates data from Events, Applications, Assignments.
    - Real-time staffing status, bottlenecks, action items

## 4. End-to-End Workflows

### Organizer Journey: "Create Event → Allocate Volunteers"

1. Organizer logs in and clicks "Create Event"
2. Enters event details: title, description, date/time, venue, eligibility rules
3. Optionally requests AI suggestions for volunteer roles
   - AI generates: role names, descriptions, required skills, recommended staffing
   - Organizer reviews and edits suggestions before saving
4. Publishes the event
5. Applications arrive from students
6. Clicks "Review Candidates" for a specific role
   - System shows applicants filtered by eligibility
   - Ranks eligible candidates with explanations (skills match, availability fit, fairness indicators)
7. Approves recommended candidates → system creates Assignments with status "pending_confirmation"
8. System sends notifications to selected students
9. Tracks confirmations on dashboard
10. At event time, records attendance
11. Post-event, collects feedback

### Student Journey: "Discover → Apply → Confirm"

1. Student logs in, completes profile: skills, interests, branch, year, availability, goals
2. Browses "Discover Events" or checks "Recommended For You"
   - Recommendations explain why each role fits
   - Indicates eligibility status (meets mandatory requirements / missing X skill)
3. Applies for a role
   - System confirms eligibility and no scheduling conflicts
   - Application status becomes "submitted"
4. Receives notification when application is reviewed or when selected
5. If selected, sees assignment and can confirm or decline
   - Declining notifies organizer, who can select a replacement
6. After event, reviews feedback and volunteering history
7. Sees recommendations for next skills to develop

## 5. Use Case Analysis: Scenarios, Edge Cases, Failure Modes

### Core Scenarios (Happy Path)

- Student creates profile → applies → is selected → confirms → attends
- Organizer creates event → reviews candidates → selects → notifies → manages
- New student applies but lacks required skill → recommendation suggests development path
- Student applies to multiple roles across events → system prevents double-booking on overlapping times

### Edge Cases

- **Selected student declines:** Organizer is notified, can select replacement from eligible waitlist without creating conflicts
- **Organizer changes role schedule after allocation:** System flags assignments that now conflict, forces review
- **Application deadline passes but organizer still needs staff:** Organizer can manually invite students (if no deadline-driven rule blocks it)
- **Multiple roles in same event compete for same student:** System prevents double-booking within same event
- **Student has borderline eligibility (one missing skill):** System allows application but flags it for organizer review; ranking adjusts accordingly
- **Concurrent allocation for same role:** Last writer wins; system must handle gracefully (implement optimistic locking or transaction if needed)

### Failure & Security Scenarios

- **Unauthorized access attempt:** Student tries to view another student's application → backend denies, returns 403
- **Organizer A tries to modify Organizer B's event:** Backend checks ownership, denies, returns 403
- **Allocation engine crash during ranking:** System must roll back; organizer can retry allocation
- **AI output contains invalid skill names:** Validation layer rejects, forces organizer to correct before saving
- **Database transaction fails mid-assignment:** Assignment remains in pending state, retry mechanism allows recovery
- **Duplicate application submission (network race):** Unique index on (eventId, roleId, studentId) prevents duplicates

## 6. Business Rules: Mandatory vs. Configurable

### Mandatory Rules (Non-Negotiable, Enforced at DB & App Level)

**Eligibility Filtering:** A student must pass all mandatory requirements (branch restrictions, required skills, qualifications) before being ranked. Failure = not eligible, regardless of AI scores.

**No Double-Booking:** A student cannot have two confirmed assignments with overlapping times unless an explicit exception is documented. System checks at confirmation time.

**Application Uniqueness:** A student can submit only one active application per role per event. Duplicate submissions are prevented or coalesced.

**Capacity Limits:** A role cannot have more confirmed assignments than its targetVolunteerCount. System enforces at assignment creation.

**Assignment Confirmation:** Allocation recommendation ≠ confirmed assignment. Selected students must explicitly confirm (or organizer confirms on their behalf in some workflows). Declining is allowed.

**Backend Authorization:** Every request that reads or modifies data checks ownership/role. Frontend UI must not be the only access control.

**AI Output Validation:** AI-generated event plans, role descriptions, and staffing suggestions must be reviewed and explicitly approved by a human organizer before persisting to the database.

### Configurable Preferences (Can Be Tuned Per Event or Globally)

| Rule | What Varies | Example |
| --- | --- | --- |
| Candidate Ranking Weights | How much to favor skills vs. interests vs. fairness | Event A: skill-heavy (70% skills, 20% interest, 10% fairness). Event B: fairness-focused (40% skills, 40% fairness, 20% interest) |
| Fairness Balancing | How to distribute opportunities to new vs. experienced volunteers | Reserve 30% of slots for new volunteers, or boost new volunteers' scores by 20% |
| Availability Strictness | Whether to require exact match or allow adjacent time windows | Require exact overlap, or allow ±15 min buffer |
| Experience Gates | Whether prior participation is required for advanced roles | Lead roles may require ≥2 prior events; general roles have no restriction |

### State Machine: Application Lifecycle

Draft → Submitted → Under Review → {Shortlisted | Rejected} Shortlisted → Selected → {Accepted | Declined} Submitted → Withdrawn (by student anytime) Waitlisted → Selected (if earlier selection declines)

### State Machine: Assignment Lifecycle

Recommended (from allocation) → Pending Confirmation → {Confirmed | Declined} Confirmed → {Cancelled | Completed} Completed → (can receive feedback)

## 7. MongoDB Data Model Proposal

**Design philosophy:** Separate collections by ownership and update frequency. Embed only when documents are tightly coupled and updated together. Use references and indexes for queries.

### Collections Overview

users

**Purpose:** Authentication identity and account state.

{ \_id: ObjectId, name: String, email: String (unique), passwordHash: String (bcrypt), role: "student" | "organizer" | "admin", accountStatus: "active" | "inactive" | "suspended", createdAt: ISODate, updatedAt: ISODate }

**Indexes:** unique on email; index on role

**Notes:** Keep minimal; extend with role-specific profiles. Never expose passwordHash to frontend.

volunteerProfiles

**Purpose:** Student-specific information for matching and recommendations.

{ \_id: ObjectId, userId: ObjectId (reference, unique), branch: String, yearOfStudy: Number, skills: \[{ name: String, proficiency: "beginner"|"intermediate"|"advanced" }\], interests: \[String\], experience: \[{ eventId: ObjectId, roleTitle: String, year: Number }\], availability: { startDate: ISODate, endDate: ISODate, blockedDates: \[ISODate\] }, developmentGoals: \[String\], preferences: { eventCategories: \[String\], maxHoursPerMonth: Number }, createdAt: ISODate, updatedAt: ISODate }

**Indexes:** unique on userId; compound indexes on (branch, yearOfStudy) for filtering

**Notes:** Skills and interests are used by recommendation engine and allocation ranking. Keep experience array finite or consider separate collection if unbounded growth expected.

events

**Purpose:** Event-level metadata owned by organizers.

{ \_id: ObjectId, title: String, description: String, category: String, organizerId: ObjectId (reference), visibility: "draft" | "published" | "archived", eligibleBranches: \[String\] (null = all branches eligible), startAt: ISODate, endAt: ISODate, timeZone: String (e.g., "Asia/Kolkata"), venue: { name: String, address: String, mapLink: String? }, applicationDeadline: ISODate, status: "draft" | "published" | "ongoing" | "completed" | "cancelled", createdAt: ISODate, updatedAt: ISODate, updatedBy: ObjectId (audit) }

**Indexes:** index on organizerId, visibility, status; compound on (visibility, startAt) for discovery

**Notes:** Roles are in a separate collection (see EventRoles below). Event-level metadata stays here.

eventRoles

**Purpose:** Volunteer positions within events; flexible schema per role.

{ \_id: ObjectId, eventId: ObjectId (reference), title: String, description: String, responsibilities: \[String\], requiredSkills: \[String\], preferredSkills: \[String\], mandatoryRequirements: { minBranches: \[String\]? (if null, all eligible), minYearOfStudy: Number?, priorEventsRequired: Number? }, targetVolunteerCount: Number, shiftStartAt: ISODate, shiftEndAt: ISODate, status: "active" | "closed" | "cancelled", createdAt: ISODate, updatedAt: ISODate }

**Indexes:** index on eventId; compound on (eventId, status)

**Notes:** Separate from events to allow independent updates and efficient role-based queries. targetVolunteerCount drives capacity limits in assignments.

applications

**Purpose:** Student applications to specific roles; application state machine lives here.

{ \_id: ObjectId, eventId: ObjectId (reference), roleId: ObjectId (reference), studentId: ObjectId (reference), status: "draft" | "submitted" | "under_review" | "shortlisted" | "selected" | "rejected" | "withdrawn" | "waitlisted", answers: \[{ questionId: String, answer: String }\]?, submittedAt: ISODate, reviewedBy: ObjectId? (organizer who reviewed), reviewedAt: ISODate?, createdAt: ISODate, updatedAt: ISODate }

**Indexes:** unique compound on (eventId, roleId, studentId) with filter on status != "withdrawn"; index on studentId; compound on (eventId, status)

**Notes:** Status transitions are validated at application layer. Withdrawal or rejection doesn't delete the record (audit trail). Unique index ensures one active application per (event, role, student).

assignments

**Purpose:** Confirmed or proposed volunteer assignments; separates application (intent) from assignment (commitment).

{ \_id: ObjectId, eventId: ObjectId (reference), roleId: ObjectId (reference), studentId: ObjectId (reference), applicationId: ObjectId (reference, can be null for manual invite), shiftStartAt: ISODate, shiftEndAt: ISODate, status: "pending_confirmation" | "confirmed" | "declined" | "cancelled" | "completed", confirmedAt: ISODate?, confirmedBy: String ("student" | "organizer")?, attendanceStatus: "not_checked_in" | "checked_in" | "no_show"?, attendedAt: ISODate?, createdAt: ISODate, updatedAt: ISODate }

**Indexes:** unique compound on (eventId, roleId, studentId, status) where status in ("pending_confirmation", "confirmed") to prevent double-booking; index on studentId; compound on (eventId, status)

**Notes:** Prevents conflicting confirmed assignments. shiftStartAt/shiftEndAt may differ from role times (e.g., student assigned to half-shift). attendance tracking is post-event.

notifications

**Purpose:** In-app event log for user-facing notifications.

{ \_id: ObjectId, userId: ObjectId (reference), type: "application_submitted" | "application_status_changed" | "selected" | "assignment_confirmation_requested" | ... , title: String, message: String, relatedEventId: ObjectId?, relatedApplicationId: ObjectId?, relatedAssignmentId: ObjectId?, readAt: ISODate?, createdAt: ISODate }

**Indexes:** index on userId; compound on (userId, readAt); index on createdAt for archival

**Notes:** No deletion; mark as read instead. Can later extend with email/SMS channels via outbox pattern.

feedback

**Purpose:** Post-event evaluations; informs future recommendations and fairness decisions.

{ \_id: ObjectId, eventId: ObjectId (reference), assignmentId: ObjectId (reference), studentId: ObjectId (reference), submittedBy: ObjectId (organizer), feedbackType: "volunteer_evaluation" | "participant_survey", rating: Number? (1-5), comments: String, skillsObserved: \[String\]?, areasForImprovement: \[String\]?, createdAt: ISODate }

**Indexes:** compound on (eventId, studentId); index on assignmentId

**Notes:** Access-controlled: organizers see feedback they submitted; students see feedback about themselves (with permission). Do not auto-exclude students based on single low rating.

allocationRuns (Optional, for Auditing)

**Purpose:** Log allocation decisions for transparency and debugging.

{ \_id: ObjectId, eventId: ObjectId, roleId: ObjectId, runId: String (UUID), criteria: { weights: Object, fairnessMode: String, ... }, candidatesEvaluated: \[{ studentId, eligible: Bool, score: Number, ranking: Number }\], recommended: \[{ studentId, score, reason }\], confirmed: \[{ studentId, confirmedAt }\], runAt: ISODate, runBy: ObjectId (organizer) }

**Notes:** Optional but recommended for transparency. Allows organizers to understand why certain candidates were ranked. Access-controlled: only event organizer and admin can view.

aiRecommendations (Optional)

**Purpose:** Store AI-generated planning suggestions for organizers to review.

{ \_id: ObjectId, eventId: ObjectId (reference), type: "role_suggestions" | "staffing_plan" | "checklist", content: Object (AI response, JSON), approved: Boolean, approvedAt: ISODate?, usedAt: ISODate?, createdAt: ISODate }

**Notes:** AI output is stored but not applied until organizer explicitly approves. Tracks which suggestions were used, enabling feedback loop for AI improvements.

### Key Design Decisions

#### Embedding vs. Referencing

- **Roles are separate from Events:** Events often have 3–10 roles. Storing separately allows role-specific queries, role-independent updates, and cleaner document sizes.
- **Skills & Interests are embedded in VolunteerProfiles:** Tightly coupled, frequently updated together, bounded in size.
- **Application answers may be embedded or referenced:** For MVP, embed in applications; later, can move to separate collection if answers grow large.
- **Venue is embedded in Events:** One venue per event, updated rarely, small document.

#### Indexes for Common Queries

- Find events a student can apply to: index on (visibility, applicationDeadline, startAt)
- Find applications for a role: compound index on (roleId, status)
- Prevent double-booking: unique index on (studentId, status) where status in ("pending_confirmation", "confirmed") with time overlap validation in app
- Find notifications for a user: index on (userId, readAt)
- Organizer dashboard: compound indexes on (eventId, status) for applications and assignments

#### Consistency & Race Conditions

**Double-Booking Prevention:** When creating or confirming an assignment, use a database transaction (MongoDB 4.2+) or application-level locking:

- Check for existing confirmed assignments on same student within overlapping time window
- If none, create the assignment with status "confirmed"
- If a conflict exists, reject with clear error message

**Capacity Limits:** When confirming an assignment for a role:

- Count current confirmed assignments for that role
- If count \< targetVolunteerCount, allow confirmation
- If count ≥ targetVolunteerCount, reject or offer waitlist
- Use atomic operations (increment-on-read patterns) or transactions to avoid race conditions

#### Deletion & Retention

- **Never hard-delete users, events, or applications.** Mark as inactive or cancelled; archive old data separately.
- **Notifications:** Archive old (read + >30 days old) notifications monthly; keep recent ones.
- **Feedback:** Retain indefinitely for fairness audits and learning.

## 8. AI vs. Deterministic Logic (Clear Boundary)

### Deterministic Application Logic (Must Stay in Code)

- Eligibility checks (branch, required skills, min experience)
- Deadline validation (application closed if past deadline)
- Availability & schedule conflict detection
- Duplicate application prevention
- Capacity enforcement (role staffing limits)
- Assignment state transitions (submitted → under_review → selected → confirmed)
- Double-booking prevention
- Backend authorization (who can access what)
- Data validation (required fields, data types, constraints)
- Transaction rollback on failure

### AI-Assisted (Input, Not Decision Maker)

- **Event Co-Pilot:** Suggests role descriptions, staffing counts, responsibilities, skill lists
  - Organizer reviews and edits before saving
  - Invalid output (e.g., nonsensical skill names) is rejected; organizer corrects
- **Candidate Ranking:** AI provides a suitability score for candidates who pass eligibility filtering
  - Score is one of multiple ranking factors (skills relevance, interests, fairness)
  - Organizer sees ranking with explanations but makes final selection
  - AI cannot override mandatory eligibility checks
- **Volunteer Guide:** Recommends events and roles to students based on profile
  - Explains why a role fits (relevant skills, interests, goals)
  - Respects eligibility rules and availability
  - Does not guarantee selection
- **Fairness Insights:** AI identifies staffing gaps, suggests balance of new vs. experienced volunteers
  - Organizer decides whether to implement suggestions

### Key Principles

**Explainability:** Every AI-assisted recommendation must come with a clear explanation of why (e.g., "Suggested because: relevant React experience, available on event date, has not volunteered for 3 months").

**Auditability:** Allocation runs are logged (allocationRuns collection) so organizers can review decisions later and understand the ranking.

**No Opaque Decisions:** AI-generated output is never directly persisted without human review. Organizers always have the opportunity to edit, reject, or ask for alternatives.

**Mandatory Rules Trump AI:** If AI suggests a candidate who fails a mandatory eligibility rule, the system rejects the suggestion and flags the issue.

## 9. MVP Scope: The Smallest Useful Version

Build these features to reach a demonstrable, valuable MVP. Avoid MVP bloat; later phases add polish and advanced features.

### MVP Features (Phase 1 + Phase 2)

#### Authentication & Profiles

- User registration (email + password, or OAuth)
- Login and session management
- Role-based access control (student vs. organizer vs. admin)
- Student profile creation (skills, interests, branch, year, availability)
- Profile editing and viewing

#### Event Management (Organizer)

- Create event (title, description, date, venue, eligibility)
- Define volunteer roles (title, description, target count, required/preferred skills)
- Set eligibility requirements (branch restrictions, required experience)
- Publish event
- View event applications and application status

#### Applications (Student)

- Browse published events
- View event and role details
- Check eligibility for roles
- Apply for a role (with basic validation)
- View own application status
- Withdraw application

#### Smart Allocation (Core Logic)

- Eligibility filtering (mandatory requirements check)
- Candidate ranking (simple baseline: skill match + fairness factor)
- Capacity-aware allocation (don't exceed target count)
- Conflict detection (no overlapping confirmed assignments)
- Organizer review and selection UI
- Assignment creation and confirmation

#### Notifications

- In-app notifications for key events (application submitted, selected, assignment confirmed)
- Mark notifications as read
- View notification history

#### Dashboards (Basic)

- Student dashboard: applications, confirmed assignments, recommendations
- Organizer dashboard: event status, application counts, staffing progress, pending actions

### MVP Non-Features (Phase 3+)

- AI Event Co-Pilot (organizers manually define roles)
- AI Volunteer Guide (students browse events manually)
- QR attendance check-in (manual attendance recording)
- Detailed feedback forms (basic yes/no attendance only)
- Advanced analytics and reporting
- Email/SMS notifications (in-app only)
- Maps and venue details (optional link only)
- Advanced fairness tuning (fixed baseline scoring)

### Why This Scope Works

- **Demonstrates core value:** Students find events, organizers allocate fairly, conflicts are prevented.
- **Testable:** All features are deterministic; no AI complexity in MVP.
- **Achievable in hackathon timeframe:** \~40–60 hours of development.
- **Foundation for later phases:** AI and advanced features slot in without architectural redesign.

## 10. Implementation Roadmap & Dependencies

### Phase 1: Core Platform (Weeks 1–2)

\[Setup\] → \[Auth\] → \[Profiles\] → \[Event Creation\] ↓ ↓ ↓ ↓ Setup project, MongoDB, API structure User registration, login, JWT/sessions Student profiles (create, edit, view) Organizer can create events with roles

- **Project setup:** Next.js or Node.js + Express, MongoDB, environment config
- **Authentication:** Email/password (bcrypt) or OAuth (Google)
- **Database schema:** users, volunteerProfiles, events, eventRoles
- **API endpoints:** POST /api/auth/register, POST /api/auth/login, GET /api/profile, PUT /api/profile, POST /api/events, GET /api/events/:id, POST /api/events/:id/roles
- **Frontend:** Login page, profile page, event creation form
- **Testing:** Unit tests for auth, CRUD operations

### Phase 2: Applications & Allocation (Weeks 2–3)

\[Browse Events\] → \[Apply\] → \[Eligibility Check\] → \[Allocation\] → \[Confirm\] ↓ ↓ ↓ ↓ ↓ Event discovery Event application Mandatory checks Ranking & review Assignment for students submission Schedule conflicts organizer select student confirm

- **Event discovery:** GET /api/events (with filters for branch, deadline, availability)
- **Applications:** POST /api/events/:id/roles/:roleId/apply, GET /api/applications, PUT /api/applications/:id (withdraw)
- **Eligibility engine:** CheckEligibility service (mandatory requirements, availability, conflicts)
- **Allocation:** AllocateVolunteers service (ranking, capacity, recommendations)
- **Assignments:** POST /api/events/:id/roles/:roleId/assignments, PUT /api/assignments/:id (confirm/decline)
- **Frontend:** Event browsing page, application form, organizer review UI, allocation results
- **Database:** applications, assignments collections
- **Testing:** Eligibility checks, conflict detection, allocation logic

### Phase 3: Coordination (Week 3–4)

- **Notifications:** POST /api/notifications (triggered by app status changes, assignments), GET /api/notifications
- **Dashboards:** GET /api/student/dashboard (applications, assignments, stats), GET /api/organizer/dashboard (event status, staffing, pending actions)
- **Attendance:** POST /api/assignments/:id/attendance (mark as present/absent)
- **Frontend:** Notification bell, student dashboard, organizer dashboard
- **Database:** notifications collection

### Phase 4: AI Features (After MVP Demo)

- **Event Co-Pilot:** POST /api/events/:id/suggest-roles (calls LLM, returns JSON), organizer edits and saves
- **Volunteer Guide:** GET /api/student/recommendations (calls LLM, returns event/role suggestions with explanations)
- **Fairness insights:** POST /api/events/:id/allocation-insights (AI suggests staffing balance)
- **API integration:** OpenAI, Anthropic, or Cohere (configurable, with prompt templates)
- **Validation:** Output validation before persistence

### Phase 5: Polish & Advanced (Post-Hackathon)

- QR attendance check-in
- Detailed feedback forms and skill tracking
- Email / SMS notifications
- Advanced reporting and analytics
- UI refinement and accessibility
- Performance optimization

### Critical Dependencies

| Feature | Depends On | Why |
| --- | --- | --- |
| Event Creation | Authentication | Organizer identity must be known |
| Applications | Events + Eligibility Engine | Can't apply if event doesn't exist; eligibility checked on submit |
| Allocation | Applications + Availability Checking | Must have candidates and know their availability |
| Assignments | Allocation + Conflict Detection | Allocation ranks candidates; conflict detection prevents double-booking |
| Dashboards | Events + Applications + Assignments | Dashboard aggregates these records |
| AI Features | Events + Applications + All Core Features | Can be added after MVP without breaking existing flows |

## 11. Open Questions for Clarification

**Q1: Authentication Method?** Do you have a preference for email/password (with bcrypt hashing) or OAuth (Google, Microsoft, GitHub)? For a college hackathon, institutional email via OAuth may be best.

**Q2: Candidate Ranking Baseline?** For MVP allocation, I propose a simple baseline: 40% skill relevance + 40% fairness (prefer students with fewer prior events) + 20% availability fit. Does this align, or would you prefer different weights?

**Q3: Fairness Definition?** Should "fairness" mean (a) equal distribution of opportunities across all students, or (b) priority for students who haven't volunteered recently? Or a mix?

**Q4: Organizer Invite Workflow?** Should organizers be able to manually invite students to roles (outside the application process), or strictly through applications?

**Q5: Feedback Access?** Can students view feedback organizers write about them? Should feedback be visible to other organizers?

**Q6: AI Provider?** Once we reach Phase 4, which AI API should we target: OpenAI (GPT-4), Anthropic (Claude), Cohere, or something else?

**Q7: Multi-Event Conflicts?** If a student has a confirmed assignment for Event A (10 AM–2 PM) and applies for Event B (1 PM–5 PM on the same day), should the system block the application or allow it for organizer review?

**Q8: Organizer Groups?** Should multiple users be able to co-organize the same event? If so, what access levels (edit, view, allocate)?

**Q9: Student Self-Service Cancellation?** After confirming an assignment, can students cancel up to a deadline, or is cancellation blocked?

**Q10: Data Retention?** How long should we keep historical feedback and event data? (Indefinite, 1 year, 3 years?)

## 12. Technical Recommendations (Stack & Architecture)

### Recommended Tech Stack

Frontend

**Next.js 14+ (React)**

App router, built-in API routes, SSR, TypeScript support, fast development velocity. Ideal for hackathon pace.

Backend

**Next.js API Routes or Node.js + Express**

If using Next.js, API routes are sufficient for MVP. Alternatively, Express for clearer separation.

Database

**MongoDB (Atlas for cloud, or local for dev)**

Required per project spec. Use MongoDB Atlas for easy scaling and backups.

ORM / Driver

**Mongoose or native MongoDB driver**

Mongoose provides schema validation and convenience; native driver is lighter-weight. Start with Mongoose for rapid development.

Authentication

**NextAuth.js (if Next.js) or JWT**

NextAuth.js integrates seamlessly with Next.js; handles OAuth and session management. Alternative: manual JWT for more control.

UI Components

**Tailwind CSS + shadcn/ui or Material-UI**

Rapid prototyping with Tailwind; component libraries (shadcn/ui) for polished, accessible components without extra NPM bloat.

Validation

**Zod or Yup**

Type-safe schema validation for API requests and responses. Zod has better TypeScript integration.

Testing

**Jest + Supertest (for API)**

Jest for unit tests, Supertest for API endpoint testing. Vitest if you prefer lighter alternative.

### Architecture Overview

┌─────────────────────────────────────────────────────┐ │ Frontend (React + Next.js) │ │ - Pages: Login, Profile, Events, Applications, etc │ │ - Components: Event cards, forms, dashboards │ │ - State: React Context or Zustand (lightweight) │ └──────────────────┬──────────────────────────────────┘ │ HTTPS ▼ ┌─────────────────────────────────────────────────────┐ │ Backend (Next.js API Routes / Express) │ │ - Authentication middleware (JWT/session) │ │ - Authorization middleware (role checks) │ │ - Service layer (business logic) │ │ ├─ AuthService │ │ ├─ VolunteerProfileService │ │ ├─ EventService │ │ ├─ ApplicationService │ │ ├─ AllocationService (core algorithm) │ │ └─ NotificationService │ │ - Controllers/Routes │ │ - Validation (Zod) │ │ - Error handling & logging │ └──────────────────┬──────────────────────────────────┘ │ ▼ ┌─────────────────────────────────────────────────────┐ │ MongoDB (Collections as designed above) │ │ - Indexes for query performance │ │ - Validation rules at schema level │ │ - Transactions for allocation consistency │ └─────────────────────────────────────────────────────┘

### Key Architectural Decisions

#### 1. Separation of Concerns

- **Controllers:** Handle HTTP requests, call services, return responses
- **Services:** Business logic (eligibility, allocation, profile management)
- **Models:** Database interaction (Mongoose schemas or query builders)
- **Middleware:** Authentication, authorization, validation, error handling

#### 2. Allocation Engine

Implement as a dedicated service with clear inputs and outputs:

interface AllocationRequest { eventId: string roleId: string numberOfSlots: number } interface AllocationResult { recommended: \[{ studentId: string score: number eligibility: "eligible" | "ineligible" matchDetails: { skillMatch: number interestMatch: number fairnessBoost: number reasons: string\[\] } }\] ineligible: \[{ studentId: string, reason: string }\] } async function allocateVolunteers(req: AllocationRequest): Promise

#### 3. Error Handling

- Consistent error response format: `{ error: string, code: string, details?: any }`
- HTTP status codes: 400 (validation), 401 (auth), 403 (permission), 404 (not found), 409 (conflict), 500 (server)
- Logging: Use Winston or Pino for structured logs (easier debugging in hackathon)

#### 4. API Structure (RESTful)

\# Authentication POST /api/auth/register POST /api/auth/login POST /api/auth/logout # Profiles GET /api/profile (authenticated user) PUT /api/profile GET /api/profile/:userId (public profile view) # Events GET /api/events (discovery, filterable) POST /api/events (organizer only) GET /api/events/:id PUT /api/events/:id (organizer only) POST /api/events/:id/roles (organizer only) GET /api/events/:id/roles GET /api/events/:id/roles/:roleId # Applications POST /api/applications (student applies) GET /api/applications (user's applications) GET /api/applications/:id PUT /api/applications/:id (status changes) # Allocations POST /api/events/:id/roles/:roleId/allocate (organizer) GET /api/events/:id/roles/:roleId/candidates # Assignments POST /api/assignments (from allocation recommendation) GET /api/assignments/:id PUT /api/assignments/:id (confirm, decline, cancel) POST /api/assignments/:id/attendance # Notifications GET /api/notifications PUT /api/notifications/:id (mark read)

#### 5. Database Transactions

Use MongoDB transactions for critical operations:

- Confirming an assignment (check capacity, check conflicts, update assignment status, create notification)
- Allocation run (evaluate candidates, create recommendations, update role status)
- Student withdrawal (mark application withdrawn, notify organizer, suggest replacement)

### Development Workflow

- **Environment files:** .env.local for DB connection string, API keys, secrets (not in git)
- **Linting:** ESLint + Prettier for consistent code
- **Git flow:** Main branch for stable code, feature branches for development
- **Testing:** Unit tests for services; integration tests for API endpoints
- **Deployment:** Vercel for Next.js frontend + backend, or Heroku/Railway for Node.js

### Why This Stack?

- **Rapid development:** Next.js + Tailwind allows frontend iteration in minutes
- **Type safety:** TypeScript across full stack reduces bugs
- **Familiar ecosystem:** JavaScript/Node.js has libraries for everything needed
- **Scalable:** Clean architecture and MongoDB allow easy feature additions (AI, advanced allocation)
- **Hackathon-friendly:** Minimal boilerplate, good documentation, fast feedback loop

---

## Summary & Next Steps

**VOLUNTRIX is a well-scoped, valuable project with clear user value, reasonable technical complexity, and a structured implementation path.**

### What I've Provided

- Comprehensive project understanding (core value, user roles, modules, workflows)
- MongoDB schema design with indexes, consistency rules, and trade-off justification
- Clear allocation algorithm baseline (eligibility → ranking → capacity → organizer review)
- Separation of AI assistance from deterministic decision-making
- Realistic MVP scope (what's in Phase 1–2, what's later)
- Implementation roadmap with dependencies and critical paths
- 10 clarifying questions to finalize design
- Recommended tech stack with rationale

### Before We Build

1. **Review this analysis.** Does it match your vision for VOLUNTRIX?
2. **Answer the 10 open questions** (or indicate which ones you'd prefer to decide during implementation).
3. **Confirm the MVP scope.** Are there features you'd like to prioritize higher (e.g., QR attendance before feedback)?
4. **Approve the tech stack** or suggest alternatives (e.g., Django backend instead of Node.js).
5. **Finalize the team and timeline.** How many developers, what's the deadline?

### Once Approved

I will:

- Create a project structure and boilerplate (Next.js setup, MongoDB connection, basic auth)
- Implement Phase 1 incrementally (auth → profiles → events → roles)
- Write tests as we go
- Demonstrate working features early and often
- Adapt based on your feedback and hackathon constraints

**Ready to begin?** Let me know your answers to the open questions, any adjustments to the architecture, and we'll start building VOLUNTRIX.