import { describe, expect, it } from "vitest";

import {
  cleanFullName,
  emailProblem,
  fullNameProblem,
  cleanGenderDescription,
  genderProblem,
  isApuEmail,
  MAX_GENDER_DESCRIPTION,
  passwordProblem,
  profileProblems,
  semesterLabel,
  studyLevelProblem,
} from "../signup";
import { greetingName } from "../name";

describe("APU email rule", () => {
  it("accepts student addresses in the shape APU issues", () => {
    expect(emailProblem("kr25s6il@apu.ac.jp")).toBeNull();
    expect(emailProblem("fo25v2eg@apu.ac.jp")).toBeNull();
  });

  it("normalises IME input before judging it", () => {
    expect(emailProblem("ＦＯ25v2eg＠apu.ac.jp ")).toBeNull();
    expect(emailProblem("Varlee <FO25V2EG@APU.AC.JP>")).toBeNull();
  });

  it("refuses personal and other university addresses", () => {
    for (const address of [
      "someone@gmail.com",
      "gr0123ab@ed.ritsumei.ac.jp",
      "x@outlook.jp",
      "x@yahoo.co.jp",
    ]) {
      expect(emailProblem(address), address).toMatch(/@apu\.ac\.jp/);
    }
  });

  it("refuses lookalikes of the domain", () => {
    expect(isApuEmail("x@apu.ac.jp.evil.com")).toBe(false);
    expect(isApuEmail("x@st.apu.ac.jp")).toBe(false);
    expect(isApuEmail("x@notapu.ac.jp")).toBe(false);
    expect(isApuEmail("x@apu.ac.jp@gmail.com")).toBe(false);
    expect(isApuEmail("@apu.ac.jp")).toBe(false);
  });

  it("lets the admin's personal address through as the one exception", () => {
    expect(emailProblem("fvarlee@gmail.com")).toBeNull();
  });

  it("asks for an address when there is none", () => {
    expect(emailProblem("   ")).toMatch(/enter/i);
  });
});

describe("full name", () => {
  it("accepts names as ID cards print them", () => {
    expect(fullNameProblem("FOFANA VARLEE")).toBeNull();
    expect(fullNameProblem("Nguyễn Thị Minh")).toBeNull();
    expect(fullNameProblem("O'Brien-Smith Jr.")).toBeNull();
    expect(fullNameProblem("山田 太郎")).toBeNull();
    expect(fullNameProblem("Suharto")).toBeNull();
  });

  it("refuses empty, one-letter, numeric and symbol names", () => {
    expect(fullNameProblem("")).not.toBeNull();
    expect(fullNameProblem(" A ")).not.toBeNull();
    expect(fullNameProblem("user123")).not.toBeNull();
    expect(fullNameProblem("<script>")).not.toBeNull();
    expect(fullNameProblem("x".repeat(101))).not.toBeNull();
  });

  it("stores the name with its spacing tidied", () => {
    expect(cleanFullName("  FOFANA　  Varlee ")).toBe("FOFANA Varlee");
  });
});

describe("password", () => {
  it("needs eight characters and a matching confirmation", () => {
    expect(passwordProblem("short")).toMatch(/8/);
    expect(passwordProblem("long enough", "long enougj")).toMatch(/match/);
    expect(passwordProblem("long enough", "long enough")).toBeNull();
  });
});

describe("welcome questions", () => {
  it("requires every question, and at least one reason", () => {
    expect(profileProblems({ college: null, semester: null, reasons: [] })).toEqual({
      college: expect.any(String),
      semester: expect.any(String),
      reasons: expect.any(String),
    });
  });

  it("passes a complete set of answers, including several reasons", () => {
    expect(
      profileProblems({ college: "ST", semester: "8", reasons: ["jpt_prep", "improve_japanese"] }),
    ).toEqual({});
  });

  it("refuses answers outside the lists", () => {
    const problems = profileProblems({ college: "LAW", semester: "9", reasons: ["fun"] });
    expect(Object.keys(problems).sort()).toEqual(["college", "reasons", "semester"]);
  });

  it("takes Graduated as an answer, because a finished degree has no semester", () => {
    expect(
      profileProblems({ college: "APS", semester: "graduated", reasons: ["japanese_class"] }),
    ).toEqual({});
  });

  it("names semesters the way students say them", () => {
    expect(["1", "2", "3", "8"].map(semesterLabel)).toEqual([
      "1st semester",
      "2nd semester",
      "3rd semester",
      "8th semester",
    ]);
    // Not "graduated semester", which is not a thing anyone says.
    expect(semesterLabel("graduated")).toBe("Graduated");
    expect(semesterLabel(null)).toBeNull();
    expect(semesterLabel("9")).toBeNull();
  });
});

describe("the signup questions about the student", () => {
  it("takes the three answers and refuses anything else", () => {
    expect(genderProblem("female", "")).toBeNull();
    expect(genderProblem("male", "")).toBeNull();
    expect(genderProblem(null, "")).toEqual(expect.any(String));
    expect(genderProblem("Female", "")).toEqual(expect.any(String));
  });

  it("asks the student who chose other to say what they mean", () => {
    expect(genderProblem("other", "")).toEqual(expect.any(String));
    expect(genderProblem("other", "   ")).toEqual(expect.any(String));
    expect(genderProblem("other", "non-binary")).toBeNull();
  });

  it("holds the write-in to the length the column allows", () => {
    expect(genderProblem("other", "x".repeat(MAX_GENDER_DESCRIPTION))).toBeNull();
    expect(genderProblem("other", "x".repeat(MAX_GENDER_DESCRIPTION + 1))).toEqual(
      expect.any(String),
    );
  });

  it("normalises the write-in the way it normalises a name", () => {
    // A full-width space is what the Japanese IME types, and it is a space.
    expect(cleanGenderDescription("non　 binary ")).toBe("non binary");
  });

  it("takes undergraduate or graduate, and nothing else", () => {
    expect(studyLevelProblem("undergraduate")).toBeNull();
    expect(studyLevelProblem("graduate")).toBeNull();
    expect(studyLevelProblem(null)).toEqual(expect.any(String));
    expect(studyLevelProblem("postgraduate")).toEqual(expect.any(String));
  });
});

describe("greetingName", () => {
  it("greets by the full name, title-cased when it arrived in capitals", () => {
    expect(greetingName({ full_name: "FOFANA VARLEE" })).toBe("Fofana Varlee");
    expect(greetingName({ full_name: "O'BRIEN-SMITH ANNA" })).toBe("O'Brien-Smith Anna");
  });

  it("keeps a name typed in mixed case as it was typed", () => {
    expect(greetingName({ full_name: "Varlee McFofana" })).toBe("Varlee McFofana");
  });

  it("prefers an explicit first name", () => {
    expect(greetingName({ first_name: "varlee", full_name: "Varlee Fofana" })).toBe("Varlee");
  });

  it("returns null with no name at all", () => {
    expect(greetingName(undefined)).toBeNull();
    expect(greetingName({})).toBeNull();
  });
});
