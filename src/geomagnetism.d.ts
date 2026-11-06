declare module "geomagnetism" {
  type Point = { decl: number; incl: number; f: number };
  const geomagnetism: { model(date?: Date): { point(coords: [number, number, number?]): Point } };
  export default geomagnetism;
}
declare module "*?worker&url" {
  const url: string;
  export default url;
}
