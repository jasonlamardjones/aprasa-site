#!/usr/bin/env node
import assert from 'node:assert/strict';
import {evaluateCurrentness as check} from './lib/currentness-contract.mjs';
const day = date => ({precision:'day',date});
const instant=(datetime,time_zone)=>({precision:'instant',datetime,time_zone});
const at=(record,now)=>check(record,now);
// Inclusive Cabo Verde final day; no 07:00 maintenance-time dependency.
const d={applicationDeadline:day('2026-10-29')};
assert.equal(at(d,'2026-10-30T00:59:59Z').applicationStatus,'not-closed');
assert.equal(at(d,'2026-10-30T01:00:00Z').applicationStatus,'closed');
assert.equal(at(d,'2026-10-29T15:00:00Z').applicationExpiryInstant,'2026-10-30T01:00:00.000Z');
// Application closure does not end an upcoming or underway activity.
const course={applicationDeadline:day('2026-10-29'),activityStart:day('2026-11-10'),activityEnd:day('2026-11-15')};
assert.deepEqual([at(course,'2026-10-30T12:00:00Z').applicationStatus,at(course,'2026-10-30T12:00:00Z').activityStatus],['closed','upcoming']);
assert.equal(at(course,'2026-11-12T12:00:00Z').activityStatus,'underway');
assert.equal(at(course,'2026-11-16T00:59:59Z').activityStatus,'underway');
assert.equal(at(course,'2026-11-16T01:00:00Z').activityStatus,'ended');
assert.equal(at(course,'2026-10-30T12:00:00Z').activityExpiryInstant,'2026-11-16T01:00:00.000Z');
// Verified exact source-zone offsets, including DST boundary days.
assert.equal(at({applicationDeadline:instant('2026-10-29T23:59:00-04:00','America/New_York')},'2026-10-30T03:59:00Z').applicationStatus,'closed');
assert.equal(at({applicationDeadline:instant('2026-11-02T23:59:00-05:00','America/New_York')},'2026-11-03T04:58:59Z').applicationStatus,'not-closed');
assert.equal(at({applicationDeadline:instant('2026-11-02T23:59:00-05:00','America/New_York')},'2026-11-03T04:59:00Z').applicationStatus,'closed');
assert.throws(()=>at({applicationDeadline:instant('2026-11-02T23:59:00-04:00','America/New_York')},'2026-11-02T12:00:00Z'),/MISMATCH/);
assert.throws(()=>at({applicationDeadline:{precision:'instant',datetime:'2026-10-29T23:59:00'}},'2026-10-28T12:00:00Z'),/TIME_ZONE_REQUIRED/);
assert.throws(()=>at({applicationDeadline:day('2026-02-30')},'2026-02-01T01:00:00Z'),/INVALID_DAY/);
assert.throws(()=>at({},'2026-10-30T02:00:00'),/INVALID_INSTANT/);
// Unknown and month-only endings cannot be fabricated into expiry.
assert.equal(at({},'2026-11-20T12:00:00Z').applicationStatus,'unknown');
assert.equal(at({activityEnd:{precision:'month',month:'2026-11'}},'2026-11-20T12:00:00Z').activityStatus,'review-due');
assert.equal(at({activityEnd:{precision:'month',month:'2026-11'}},'2026-11-20T12:00:00Z').activityExpiryInstant,null);
assert.equal(at({ongoing:true},'2026-11-20T12:00:00Z').activityStatus,'ongoing');
// Month precision must never become review-due before the governed month.
const monthOnly={activityEnd:{precision:'month',month:'2026-11'}};
assert.equal(at(monthOnly,'2026-10-31T23:59:59Z').activityStatus,'unknown');
assert.equal(at(monthOnly,'2026-10-31T23:59:59Z').reviewDue,false);
assert.equal(at(monthOnly,'2026-11-01T00:59:59Z').reviewDue,false);
assert.equal(at(monthOnly,'2026-11-01T01:00:00Z').activityStatus,'review-due');
assert.equal(at(monthOnly,'2026-11-01T01:00:00Z').reviewDue,true);
const applicationMonth={applicationDeadline:{precision:'month',month:'2026-11'}};
assert.equal(at(applicationMonth,'2026-10-26T12:00:00Z').applicationStatus,'unknown');
assert.equal(at(applicationMonth,'2026-11-01T01:00:00Z').applicationStatus,'review-due');
const startMonth={activityStart:{precision:'month',month:'2026-12'}};
assert.equal(at(startMonth,'2026-11-20T12:00:00Z').activityStatus,'unknown');
assert.equal(at(startMonth,'2026-12-01T01:00:00Z').activityStatus,'review-due');
assert.throws(()=>at({activityStart:day('2026-12-10'),activityEnd:day('2026-11-30')},'2026-11-15T12:00:00Z'),/CONTRADICTORY_ACTIVITY_RANGE/);
assert.throws(()=>at({activityStart:day('2026-12-01'),activityEnd:day('2026-11-30')},'2026-11-15T12:00:00Z'),/CONTRADICTORY_ACTIVITY_RANGE/);
assert.equal(at({activityStart:day('2026-11-30'),activityEnd:day('2026-11-30')},'2026-11-30T12:00:00Z').activityStatus,'underway');
// Future discovery uses a Cabo Verde calendar-day window.
assert.equal(at({activityStart:day('2026-12-29')},'2026-10-30T12:00:00Z').activityStatus,'upcoming');
assert.equal(at({activityStart:day('2026-12-30')},'2026-10-30T12:00:00Z').activityStatus,'future');
// No mutation; deterministic replay and independent projection fields.
const record={activityEnd:day('2026-10-29'),resource_id:'x',directory_eligible:true,home_selected:false};
const before=JSON.stringify(record), first=at(record,'2026-10-30T01:00:00Z');
assert.deepEqual(first,at(record,'2026-10-30T01:00:00Z'));
assert.equal(JSON.stringify(record),before);
assert.equal('home_selected' in first,false);
console.log('currentness contract unit tests passed');
