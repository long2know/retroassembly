import { z } from 'zod'

export const collectionNameMaxLength = 60
export const collectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(collectionNameMaxLength)
  .regex(/^\P{Cc}+$/u)
