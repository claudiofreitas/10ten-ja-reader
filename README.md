# Rikaichamp!

[![CircleCI](https://circleci.com/gh/birtles/rikaichamp.svg?style=svg)](https://circleci.com/gh/birtles/rikaichamp)
[![Greenkeeper badge](https://badges.greenkeeper.io/birtles/rikaichamp.svg)](https://greenkeeper.io/)

Look up Japanese words with the hover of a mouse.

Rikaichamp is a port of rikaikun, which is a port of rikaichan, which is a port
of rikaiXUL. It aims to be simple, reliable, fast, and up-to-date.

It includes simple installation, an up-to-date dictionary, many many bug fixes
over its predecessors (e.g. it correctly recognizes the causative passive),
automated tests and type-checking, and modern API usage (no sync XHR, XPath
etc.).

Twitter: [@rikaichamp](https://twitter.com/rikaichamp)

## Development

```
git clone https://github.com/birtles/rikaichamp.git
yarn install
```

The install step above will build the add-on and put the output in
`dist-firefox`. To build again you can use:

```
yarn build
```

Or to build the Chrome version:

```
yarn build:chrome
```

Or to build and package:

```
yarn package
yarn package:chrome # Chrome version
```

## Running

For manual testing you can use:

```
yarn start
```

To use a specific version of Firefox (e.g. Nightly):

```
yarn start --firefox nightly
```

## Testing

```
yarn test
```

Unit tests only:

```
yarn test:unit
```

Browser-based tests only:

```
yarn test:browser
```

## Releasing

```
yarn version --new-version 1.2.3
# or for a pre-release version
yarn version --new-version 1.2.3pre1

# Then...
git push
git push --tags
```
