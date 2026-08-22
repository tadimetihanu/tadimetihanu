/**
 * Next.js configuration to avoid permission errors.
 * The default `.next` folder is being created in a location where the
 * current user lacks read/write permissions. By overriding `distDir` we
 * instruct Next.js to write its build artifacts to a directory inside the
 * project root (./build), which the user can freely access.
 */
module.exports = {
  // Write build output to ./build instead of the default .next folder.
  distDir: "build",
  // You can add additional Next.js config options here.
};
