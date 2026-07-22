import { getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";

const FIREBASE_APP_NAME = "seyirlik-admin";
const DEFAULT_ADMIN_EMAIL = "sonatakcaa@gmail.com";

const firebaseOptions: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
};

const requiredConfiguration = [
  ["VITE_FIREBASE_API_KEY", firebaseOptions.apiKey],
  ["VITE_FIREBASE_AUTH_DOMAIN", firebaseOptions.authDomain],
  ["VITE_FIREBASE_PROJECT_ID", firebaseOptions.projectId],
  ["VITE_FIREBASE_APP_ID", firebaseOptions.appId],
] as const;

let authInstance: Auth | null = null;

export function getConfiguredAdminEmail(): string {
  return (
    import.meta.env.VITE_FIREBASE_ADMIN_EMAIL?.trim().toLowerCase() ||
    DEFAULT_ADMIN_EMAIL
  );
}

export function getFirebaseAdminConfigurationError(): string | null {
  const missingVariables = requiredConfiguration
    .filter(([, value]) => !value)
    .map(([name]) => name);

  return missingVariables.length > 0
    ? `Firebase admin authentication is not configured. Missing: ${missingVariables.join(", ")}.`
    : null;
}

export function getFirebaseAdminAuth(): Auth {
  const configurationError = getFirebaseAdminConfigurationError();

  if (configurationError) {
    throw new Error(configurationError);
  }

  if (authInstance) {
    return authInstance;
  }

  const existingApp = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  const app = existingApp ?? initializeApp(firebaseOptions, FIREBASE_APP_NAME);

  authInstance = getAuth(app);
  return authInstance;
}

export function isAuthorizedAdminUser(user: User | null): user is User {
  return Boolean(
    user?.emailVerified &&
    user.email?.trim().toLowerCase() === getConfiguredAdminEmail(),
  );
}

export function observeAdminAuthState(
  onChange: (user: User | null) => void,
  onError: (error: Error) => void,
): () => void {
  const auth = getFirebaseAdminAuth();

  return onAuthStateChanged(auth, onChange, onError);
}

export async function signInAdminWithGoogle(): Promise<void> {
  const auth = getFirebaseAdminAuth();
  const provider = new GoogleAuthProvider();

  provider.setCustomParameters({
    login_hint: getConfiguredAdminEmail(),
    prompt: "select_account",
  });

  await setPersistence(auth, browserLocalPersistence);

  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (
      error instanceof FirebaseError &&
      [
        "auth/popup-blocked",
        "auth/operation-not-supported-in-this-environment",
      ].includes(error.code)
    ) {
      await signInWithRedirect(auth, provider);
      return;
    }

    throw error;
  }
}

export async function signOutAdmin(): Promise<void> {
  await signOut(getFirebaseAdminAuth());
}

export async function getAdminIdToken(): Promise<string> {
  const user = getFirebaseAdminAuth().currentUser;

  if (!isAuthorizedAdminUser(user)) {
    throw new Error("Authorized Google administrator sign-in is required.");
  }

  return user.getIdToken();
}
