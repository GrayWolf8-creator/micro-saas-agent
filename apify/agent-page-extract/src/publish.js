export const CHARGE_EVENTS = {
  start: 'actor-start',
  page: 'page-extracted',
};

export async function publishPage(actor, record) {
  if (record.status !== 'ok') {
    await actor.pushData(record);
    return { stop: false, pushed: true };
  }

  const charge = await actor.charge({ eventName: CHARGE_EVENTS.page });
  // Outside pay-per-event mode the SDK returns chargedCount 0 without reaching a limit.
  // A real budget stop sets eventChargeLimitReached and chargedCount 0.
  if (charge && charge.chargedCount === 0 && charge.eventChargeLimitReached) {
    return { stop: true, pushed: false };
  }
  await actor.pushData(record);
  return { stop: Boolean(charge?.eventChargeLimitReached), pushed: true };
}
