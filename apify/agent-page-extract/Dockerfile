# Playwright image so the browser fallback has Chrome. Cheerio still does the cheap first fetch.
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser:myuser package*.json ./

# The base image already contains the browsers Playwright needs.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD npm start --silent
