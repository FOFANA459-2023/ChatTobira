import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/components/login-form";
import { ProfileForm } from "@/components/profile-form";
import { SignupForm } from "@/components/signup-form";

const auth = {
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  resend: vi.fn(),
  refreshSession: vi.fn(),
};
const rpc = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth, rpc }),
}));

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", { ...window.location, origin: "https://chattobira.com", assign });
});

function fillSignup({
  name = "FOFANA VARLEE",
  email = "fo25v2eg@apu.ac.jp",
  password = "correct horse",
  confirm = undefined as string | undefined,
}: { name?: string; email?: string; password?: string; confirm?: string } = {}) {
  confirm ??= password;
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("APU email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("signup form", () => {
  it("refuses a non-APU address before anything is sent", async () => {
    render(<SignupForm />);
    fillSignup({ email: "someone@gmail.com" });
    expect(await screen.findByText(/ends in @apu\.ac\.jp/)).toBeInTheDocument();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("requires every field", async () => {
    render(<SignupForm />);
    fillSignup({ name: "", email: "", password: "" });
    expect(await screen.findByText(/as it appears on your student ID/)).toBeInTheDocument();
    expect(screen.getByText(/Enter your APU email/)).toBeInTheDocument();
    expect(screen.getByText(/at least 8 characters for your password/)).toBeInTheDocument();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("catches mismatched passwords", async () => {
    render(<SignupForm />);
    fillSignup({ confirm: "correct horsf" });
    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("signs up with the name in metadata and a confirmation link back to the app", async () => {
    auth.signUp.mockResolvedValue({
      data: { user: { identities: [{}] }, session: null },
      error: null,
    });
    render(<SignupForm />);
    fillSignup({ email: "FO25V2EG＠apu.ac.jp", name: " FOFANA   VARLEE " });
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "fo25v2eg@apu.ac.jp",
      password: "correct horse",
      options: {
        emailRedirectTo: "https://chattobira.com/auth/confirm",
        data: { full_name: "FOFANA VARLEE" },
      },
    });
  });

  it("says so when the address already has an account", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { identities: [] }, session: null }, error: null });
    render(<SignupForm />);
    fillSignup();
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });

  it("explains a refusal from the database in terms of the rules", async () => {
    auth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Database error saving new user", status: 500 },
    });
    render(<SignupForm />);
    fillSignup();
    expect(await screen.findByText(/could not be created/)).toBeInTheDocument();
  });
});

describe("login form", () => {
  function signIn(email: string, password: string) {
    fireEvent.change(screen.getByLabelText("APU email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("signs in with email and password and goes to the app", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginForm />);
    signIn("fo25v2eg@apu.ac.jp", "correct horse");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "fo25v2eg@apu.ac.jp",
      password: "correct horse",
    });
  });

  it("offers a new confirmation link when the email is not verified", async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: { code: "email_not_confirmed", message: "Email not confirmed", status: 400 },
    });
    render(<LoginForm />);
    signIn("fo25v2eg@apu.ac.jp", "correct horse");
    expect(await screen.findByText(/not verified yet/)).toBeInTheDocument();
    auth.resend.mockResolvedValue({ error: null });
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation link" }));
    await waitFor(() =>
      expect(auth.resend).toHaveBeenCalledWith({
        type: "signup",
        email: "fo25v2eg@apu.ac.jp",
        options: { emailRedirectTo: "https://chattobira.com/auth/confirm" },
      }),
    );
  });

  it("reports wrong credentials without saying which half was wrong", async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: { code: "invalid_credentials", message: "Invalid login credentials", status: 400 },
    });
    render(<LoginForm />);
    signIn("fo25v2eg@apu.ac.jp", "nope nope");
    expect(await screen.findByText("That email and password do not match.")).toBeInTheDocument();
  });

  it("sends a reset link that lands on the reset page", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: null });
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("APU email"), { target: { value: "fo25v2eg@apu.ac.jp" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() =>
      expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("fo25v2eg@apu.ac.jp", {
        redirectTo: "https://chattobira.com/auth/confirm?next=/reset-password",
      }),
    );
  });

  it("sends the admin to the admin page", async () => {
    render(<LoginForm />);
    signIn("fvarlee@gmail.com", "whatever");
    expect(await screen.findByText(/Admin page/)).toBeInTheDocument();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("welcome questions", () => {
  it("requires a college, a semester and at least one reason", async () => {
    render(<ProfileForm />);
    fireEvent.click(screen.getByRole("button", { name: "Start studying" }));
    expect(await screen.findByText("Choose your college.")).toBeInTheDocument();
    expect(screen.getByText("Choose your semester.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one reason.")).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("offers APS, APM and ST, semesters 1st to 8th, and three reasons", () => {
    render(<ProfileForm />);
    expect(screen.getAllByRole("radio", { name: /APS|APM|ST/ })).toHaveLength(3);
    for (const s of ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"]) {
      expect(screen.getByRole("radio", { name: s })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("saves several reasons at once and opens the app", async () => {
    rpc.mockResolvedValue({ error: null });
    auth.refreshSession.mockResolvedValue({});
    render(<ProfileForm />);
    fireEvent.click(screen.getByRole("radio", { name: /APM/ }));
    fireEvent.click(screen.getByRole("radio", { name: "5th" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Japanese class" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "JPT test prep" }));
    fireEvent.click(screen.getByRole("button", { name: "Start studying" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(rpc).toHaveBeenCalledWith("complete_profile", {
      p_college: "APM",
      p_semester: 5,
      p_reasons: ["japanese_class", "jpt_prep"],
    });
    expect(auth.refreshSession).toHaveBeenCalled();
  });

  it("lets a reason be unticked again", async () => {
    render(<ProfileForm />);
    const box = screen.getByRole("checkbox", { name: "Improving my Japanese" });
    fireEvent.click(box);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("radio", { name: /ST/ }));
    fireEvent.click(screen.getByRole("radio", { name: "1st" }));
    fireEvent.click(screen.getByRole("button", { name: "Start studying" }));
    expect(await screen.findByText("Choose at least one reason.")).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });
});
