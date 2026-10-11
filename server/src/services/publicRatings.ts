import type { Types } from 'mongoose';
import { PerformanceEvaluation, User } from '../models.js';

/**
 * Volunteer ratings for the student information dashboard.
 *
 * Averages are computed here, on the server, from the `overall` score of the
 * real evaluations organizers recorded — nothing is estimated or invented.
 *
 * Deliberately withheld: the reviewer's identity, the free-text feedback and
 * the per-criterion breakdown. Those are an organizer's private assessment of
 * a named student, written for the promotion review, and were not given with
 * any expectation that every student could read them. Only the aggregate
 * leaves this function.
 */
export async function listVolunteerRatings() {
  const rows = await PerformanceEvaluation.aggregate<{ _id: Types.ObjectId; count: number; average: number; latest: Date }>([
    { $group: { _id: '$studentId', count: { $sum: 1 }, average: { $avg: '$overall' }, latest: { $max: '$createdAt' } } },
  ]);
  const byStudent = new Map(rows.map((r) => [String(r._id), r]));

  // Every active student is listed, so an unrated volunteer is shown honestly
  // as "not rated yet" rather than quietly left out of the table.
  const students = await User.find({ role: { $in: ['student', 'organizer'] }, accountStatus: 'active' }).select('fullName').sort({ fullName: 1 });

  return students.map((student) => {
    const row = byStudent.get(student.id as string);
    return {
      volunteerId: student.id as string,
      displayName: student.fullName,
      ratingCount: row?.count ?? 0,
      // Null rather than 0: never rated is not the same as rated badly.
      averageRating: row ? Math.round(row.average * 10) / 10 : null,
      lastRatedAt: row?.latest ?? null,
    };
  });
}
