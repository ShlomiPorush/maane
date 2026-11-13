// A PDF a stack check bundles into itself (esbuild's documented binary loader, --loader:.pdf=binary in package.json).
declare module "*.pdf" {
  const bytes: Uint8Array
  export default bytes
}
