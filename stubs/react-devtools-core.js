// Stub for react-devtools-core: Ink only imports this when DEV=true,
// which never happens in production builds. Prevents bundling the devtools.
const devtools = {
  connectToDevTools: () => {},
  connect: () => {},
};
export default devtools;
