import assert from "node:assert/strict";
import { railFare, sgClock, timeInfo, polyKm } from "../frontend/js/fares.js";
// every band edge from the published adult table
const t = [[3.2,1.28],[3.3,1.38],[4.2,1.38],[4.3,1.49],[5.2,1.49],[5.3,1.59],[7.2,1.68],[7.3,1.75],[9.2,1.82],[9.3,1.86],[10.2,1.86],[10.3,1.90],[14.2,2.02],[14.3,2.07],[15.2,2.07],[20.2,2.27],[25.2,2.40],[26.3,2.43],[34.2,2.50],[34.3,2.51],[40.2,2.56],[40.3,2.57],[55,2.57]];
for (const [km, f] of t) assert.equal(railFare(km), f, `adult ${km} km`);
assert.equal(railFare(3.2, { earlyBird: true }), 0.78); assert.equal(railFare(40.5, { earlyBird: true }), 2.07);
assert.equal(railFare(2, { type: "student" }), 0.52); assert.equal(railFare(9, { type: "student" }), 0.78); assert.equal(railFare(2, { type: "student", earlyBird: true }), 0.02);
assert.equal(railFare(2, { type: "senior" }), 0.69); assert.equal(railFare(8, { type: "senior" }), 1.07); assert.equal(railFare(5, { type: "senior", earlyBird: true }), 0.37);
// 2026 fare review from 26 Dec 2026
assert.equal(railFare(3.0, { date: "2026-12-25" }), 1.28); assert.equal(railFare(3.0, { date: "2026-12-26" }), 1.40); assert.equal(railFare(10, { date: "2027-01-05" }), 1.99);
assert.equal(railFare(3, { type: "student", date: "2026-12-26" }), 0.57);
// peak / off-peak / early bird
const ti = (s) => timeInfo(sgClock(s));
assert.equal(ti("2026-10-12T08:15").peak, true);   // Monday morning
assert.equal(ti("2026-10-12T12:00").peak, false);  // Monday lunch
assert.equal(ti("2026-10-12T17:30").peak, true);   // Monday evening
assert.equal(ti("2026-10-12T19:00").peak, false);
assert.equal(ti("2026-10-11T08:15").peak, false);  // Sunday
assert.equal(ti("2026-10-12T07:30").earlyBird, true); assert.equal(ti("2026-10-12T07:45").earlyBird, false); assert.equal(ti("2026-10-11T07:00").earlyBird, false);
console.log(ti("2026-10-12T08:15").label, "|", ti("2026-10-11T15:20").label);
const now = sgClock(); console.log("now (Singapore):", now.iso, now.day, now.h + ":" + now.mi);
assert.ok(Math.abs(polyKm([[1.3, 103.8], [1.31, 103.8]]) - 1.112) < 0.01);
console.log("all fare tests passed");
