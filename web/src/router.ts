import { createRouter, createWebHashHistory } from "vue-router";
import OverviewView from "./views/OverviewView.vue";
import AccountView from "./views/AccountView.vue";
import ChannelsView from "./views/ChannelsView.vue";
import ActivityView from "./views/ActivityView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  linkExactActiveClass: "active",
  routes: [
    { path: "/overview", name: "overview", component: OverviewView },
    { path: "/account", name: "account", component: AccountView },
    { path: "/channels", name: "channels", component: ChannelsView },
    { path: "/activity", name: "activity", component: ActivityView },
    { path: "/:pathMatch(.*)*", redirect: "/overview" },
  ],
});
