import { prisma } from '../lib/db';
import { hashPassword } from '../lib/auth';

async function main() {
  const email = 'test@example.com';
  const password = 'testpassword123';

  // Check if user exists
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const passwordHash = await hashPassword(password);
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });
    console.log('Created test user:', email);
  } else {
    console.log('Test user already exists:', email);
  }

  console.log('You can login with:', email, password);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());