/** URL for a file in public/, under the site's base path ("/" in dev, "/<repo>/" on a Codeberg project page). */
export const asset = (path: string) => import.meta.env.BASE_URL.replace(/\/?$/, "/") + path;
