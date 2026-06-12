include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-xray-simple
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MPLv2
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=saruo
PKG_BUILD_PARALLEL:=1
PKG_BUILD_DEPENDS:=luci-base/host

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
	SECTION:=Custom
	CATEGORY:=Extra packages
	TITLE:=Simple LuCI support for Xray TProxy
	DEPENDS:=firewall4 +ip-full +kmod-nft-tproxy +luci-base +xray-core
	PKGARCH:=all
endef

define Package/$(PKG_NAME)/description
	Simple LuCI support for Xray using a user-provided JSON config and minimal TProxy settings.
endef

define Package/$(PKG_NAME)-zh
	SECTION:=Custom
	CATEGORY:=Extra packages
	TITLE:=Chinese translation for Xray Simple LuCI app
	DEPENDS:=$(PKG_NAME)
	PKGARCH:=all
endef

define Package/$(PKG_NAME)-zh/description
	Chinese translation for the Xray Simple LuCI application.
endef

define Build/Compile
	$(STAGING_DIR_HOSTPKG)/bin/po2lmo ./po/zh_Hans/xray-simple.po ./po/zh_Hans/xray-simple.zh-cn.lmo
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	if [ -f /etc/uci-defaults/xray_simple ]; then
		( . /etc/uci-defaults/xray_simple ) && rm -f /etc/uci-defaults/xray_simple
	fi
	/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1 || true
	# LuCI caches menu/view metadata aggressively; clear it so upgrades load
	# newly installed view files without requiring a reboot.
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
fi
exit 0
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/xray_simple
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_DATA) ./root/etc/config/xray_simple $(1)/etc/config/xray_simple
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/xray_simple $(1)/etc/init.d/xray_simple
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/xray_simple $(1)/etc/uci-defaults/xray_simple
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-xray-simple.json $(1)/usr/share/luci/menu.d/luci-app-xray-simple.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-xray-simple.json $(1)/usr/share/rpcd/acl.d/luci-app-xray-simple.json
	$(INSTALL_DIR) $(1)/usr/share/nftables.d/table-pre
	$(INSTALL_DATA) ./root/usr/share/nftables.d/table-pre/xray_simple.nft $(1)/usr/share/nftables.d/table-pre/xray_simple.nft
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/xray-simple
	$(INSTALL_DATA) ./root/www/luci-static/resources/view/xray-simple/core-v2.js $(1)/www/luci-static/resources/view/xray-simple/core-v2.js
endef

define Package/$(PKG_NAME)-zh/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
fi
exit 0
endef

define Package/$(PKG_NAME)-zh/install
	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_DATA) ./po/zh_Hans/xray-simple.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/xray-simple.zh-cn.lmo
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
$(eval $(call BuildPackage,$(PKG_NAME)-zh))
