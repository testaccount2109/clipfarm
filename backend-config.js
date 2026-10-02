// Account data and access tokens are only sent to this verified HTTPS origin.
const origin = "https://benni-projects.de";

module.exports = Object.freeze({
  origin,
  apiBase: origin + "/api/v1",
  healthPath: "/health"
});
