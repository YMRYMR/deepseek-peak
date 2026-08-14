/** Ambient declaration for CSS Modules imports inside this package. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
