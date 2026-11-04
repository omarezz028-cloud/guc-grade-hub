import { describe, expect, it } from "vitest";
import { parseGrades } from "@/server/guc.server";

// Sanitized structure captured from GUC's CheckGrade_01 page.
const course = "Civil Engineering 5th Semester - CIS502 Structural Analysis III";
const fixture = `
<select><option selected value="1">${course}</option></select>
<table><tr><td>Quiz/Assignment</td><td>Element Name</td><td>Grade</td><td>Prof./Lecturer/TA</td></tr>
<tr><td>Quiz 1</td><td>Question1</td><td>8.25 / 10</td><td></td></tr></table>
<div>Mid-Term Results:</div>
<table id="ContentPlaceHolderright_ContentPlaceHoldercontent_midDg">
<tr><td>Course</td><td>Percentage</td></tr>
<tr><td>Civil Engineering 5th Semester - Structural Analysis III CIS502</td><td>93.3333</td></tr>
</table>`;

describe("GUC midterm collection", () => {
  it("collects the published midterm percentage alongside coursework", () => {
    expect(parseGrades(fixture, course)).toEqual([
      { course, item: "Midterm", grade: "93.3333 / 100" },
      { course, item: "Quiz 1 – Question1", grade: "8.25 / 10" },
    ]);
  });
  it("reads midterms even without a coursework table", () => {
    expect(parseGrades(fixture.slice(fixture.indexOf('<div>')))).toEqual([
      { course: "Civil Engineering 5th Semester - Structural Analysis III CIS502", item: "Midterm", grade: "93.3333 / 100" },
    ]);
  });
  it("does not invent a score for an unpublished midterm", () => {
    expect(parseGrades(fixture.replace('93.3333', '&nbsp;'), course)).some;
    expect(parseGrades(fixture.replace('93.3333', '&nbsp;'), course).filter(row => row.item === "Midterm")).toEqual([]);
  });
});