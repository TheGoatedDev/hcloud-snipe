# hcloud-snipe

Watches Hetzner Cloud for scarce server capacity and creates servers the moment a wanted server type becomes orderable in a wanted location.

## Language

**Manifest**:
A named set of Snipes the user wants fulfilled. Its Snipes are independent; one being Fulfilled does not wait on another.
_Avoid_: config, bundle, plan

**Snipe**:
One entry in a Manifest: a Target, how many servers to Claim, and how those servers are built.
_Avoid_: job, order, watch

**Target**:
The ranked list of Candidates a Snipe accepts, best first.
_Avoid_: preferences, filter

**Candidate**:
One server type in one location that the user would accept, written `type@location` (e.g. `cax21@fsn1`).
_Avoid_: option, slot, offer

**Location**:
A Hetzner site where a server type can be ordered, named like `fsn1` or `ash`.
_Avoid_: datacentre, datacenter, region

**Sighting**:
The moment Hetzner reports a Candidate as orderable.
_Avoid_: hit, match, catch

**Claim**:
A server successfully created for a Candidate. A Sighting does not guarantee a Claim; stock can vanish between seeing it and creating it.
_Avoid_: order, purchase, grab

**Fulfilled**:
A Snipe whose Claims have reached its requested count. A Manifest is Fulfilled when all its Snipes are.
_Avoid_: done, complete, satisfied

**Alert**:
A message to the Manifest's owner about a Claim, a Fulfilled Snipe or Manifest, a fatal error, or (in a Dry run) a Sighting.
_Avoid_: dispatch (Hetzner-Cloud-Radar's term for subscriber emails), notification

**Dry run**:
Running a Manifest so that Sightings are reported but nothing is Claimed.
_Avoid_: watch mode, notify-only
