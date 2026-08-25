import type { PageServerLoad } from './$types';
import { currentMonth, projectionDefaults } from '$lib/server/stats';

export const load: PageServerLoad = () => ({
	defaults: projectionDefaults(),
	month: currentMonth()
});
