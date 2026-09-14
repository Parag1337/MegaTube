-- Link MegaTube users to Clerk identities.
-- Nullable unique: legacy password accounts stay NULL until they sign in
-- through Clerk, at which point they are linked by verified email.
-- The internal User.id is untouched - all user-owned data stays keyed by it.

ALTER TABLE "User" ADD COLUMN "clerkUserId" TEXT;

CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");
