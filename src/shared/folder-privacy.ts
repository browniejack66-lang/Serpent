import { z } from 'zod';

/**
 * Folder privacy lock — shared contract types.
 *
 * A protected scope stores a salted scrypt verifier in the library database.
 * Unlock state is memory-only in the Library Worker and is lost on restart,
 * so reopening a library always re-locks every protected scope.
 *
 * folderId uses the existing managed/linked encoded scope identity:
 *  - a managed folder id (managed_folders.folder_id), or
 *  - a linked root folder id (linked_folders.folder_id), or
 *  - an encoded linked virtual subdirectory id (encodeLinkedVirtualFolderId).
 * The scope root is stored once per protected root; descendants inherit the
 * lock by ancestor-prefix containment and are never materialized as rows.
 */
export const FOLDER_PRIVACY_ACTIONS = [
  'status',
  'protect',
  'unlock',
  'lock',
  'remove',
  'change-password',
] as const;

export type FolderPrivacyAction = (typeof FOLDER_PRIVACY_ACTIONS)[number];

export const folderPrivacyActionSchema = z.enum(FOLDER_PRIVACY_ACTIONS);

/**
 * Password policy is 1..1024 characters at the protocol boundary (the UI may
 * recommend a stronger minimum). Passwords are never persisted in plaintext.
 */
export const FOLDER_PRIVACY_PASSWORD_MIN_LENGTH = 1;
export const FOLDER_PRIVACY_PASSWORD_MAX_LENGTH = 1024;

export const folderPrivacyPasswordSchema = z
  .string()
  .min(FOLDER_PRIVACY_PASSWORD_MIN_LENGTH)
  .max(FOLDER_PRIVACY_PASSWORD_MAX_LENGTH);

export interface FolderPrivacyInput {
  libraryId: string;
  /** Required for every action except status. */
  folderId?: string;
  action: FolderPrivacyAction;
  /** Required by protect, unlock, remove and change-password. */
  password?: string;
  /** Required by change-password. */
  newPassword?: string;
}

export interface FolderPrivacyState {
  folderId: string;
  locked: boolean;
}

export interface FolderPrivacyResult {
  states: FolderPrivacyState[];
}

/**
 * Optional per-summary privacy decoration. Main may merge this into an asset
 * or folder summary so the renderer can render lock badges without a second
 * round trip. protected is the durable configuration; locked is the current
 * memory-only unlock state.
 */
export interface FolderPrivacyBadge {
  protected: boolean;
  locked: boolean;
}

export const folderPrivacyInputSchema = z
  .strictObject({
    libraryId: z.string().min(1),
    folderId: z.string().min(1).optional(),
    action: folderPrivacyActionSchema,
    password: folderPrivacyPasswordSchema.optional(),
    newPassword: folderPrivacyPasswordSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== 'status' && value.folderId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['folderId'],
        message: 'folderId is required for this action',
      });
    }
    if (
      (value.action === 'protect' ||
        value.action === 'unlock' ||
        value.action === 'remove' ||
        value.action === 'change-password') &&
      value.password === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'password is required for this action',
      });
    }
    if (value.action === 'change-password' && value.newPassword === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: 'newPassword is required for change-password',
      });
    }
  });
