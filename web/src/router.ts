import { createRouter, createWebHashHistory } from "vue-router";
import OverviewView from "./views/OverviewView.vue";
import AccountView from "./views/AccountView.vue";
import ChannelsView from "./views/ChannelsView.vue";
import SettingsView from "./views/SettingsView.vue";
import LogsView from "./views/LogsView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  linkExactActiveClass: "active",
  routes: [
    { path: "/overview", name: "overview", component: OverviewView },
    { path: "/account", name: "account", component: AccountView },
    { path: "/channels", name: "channels", component: ChannelsView },
    { path: "/settings", name: "settings", component: SettingsView },
    { path: "/logs", name: "logs", component: LogsView },
    { path: "/activity", redirect: "/logs" },
    { path: "/:pathMatch(.*)*", redirect: "/overview" },
  ],
});
