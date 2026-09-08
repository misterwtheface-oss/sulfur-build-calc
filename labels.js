/*
  labels.js — front-end display standardization for backend data tags.
  window.SULFUR_LABELS.attr maps an ItemAttributes/EntityAttributes tag to how it should
  read in the UI. app.js routes every attribute display through label(tag).

  Entry shape: { name, cat?, lowerBetter?, flag? }
    name        — human display text
    cat         — grouping bucket (Weapon / Handling / Projectile / On-hit / Player / Loot / Meta)
    lowerBetter — true if a smaller value is the improvement (recoil, spread, reload time)
    flag        — true for on/off attributes (shown as ON, not a number)

  IMPORTANT semantics (SULFUR is an immersive-sim: armor buffs your BULLETS):
    ProjectileApply*   = your projectiles APPLY a status on hit (offensive), NOT a defensive stat.
    ProjectileMoveAsLight = projectiles travel at light speed. Player move speed is ItemStat_MoveSpeed.
  Edit any label below to taste — this file is the single source of display truth.
*/
(function () {
  window.SULFUR_LABELS = {
    attr: {
      // --- weapon core ---
      Damage: { name: "Damage", cat: "Weapon" },
      DamageModifier: { name: "Damage Modifier", cat: "Weapon" },
      RPM: { name: "Fire Rate", cat: "Weapon" },
      Spread: { name: "Spread", cat: "Handling", lowerBetter: true },
      CritChance: { name: "Crit Chance", cat: "Weapon" },
      CritChanceADS: { name: "Crit Chance (ADS)", cat: "Weapon" },
      FullAuto: { name: "Full-Auto", cat: "Weapon", flag: true },
      Lifesteal: { name: "Lifesteal", cat: "Weapon" },
      Experience: { name: "Experience Gain", cat: "Meta" },
      // --- handling / recoil / ammo ---
      KickMultiplier: { name: "Recoil", cat: "Handling", lowerBetter: true },
      KickCompensation: { name: "Recoil Compensation", cat: "Handling" },
      ReloadSpeed: { name: "Reload Speed", cat: "Handling", lowerBetter: true },
      AimMovingBonus: { name: "Aim While Moving", cat: "Handling" },
      DisableADS: { name: "No Aim-Down-Sights", cat: "Handling", flag: true },
      Silenced: { name: "Silenced", cat: "Handling", flag: true },
      DisableMuzzleFlash: { name: "No Muzzle Flash", cat: "Handling", flag: true },
      MaxDurability: { name: "Max Durability", cat: "Handling" },
      Durability: { name: "Durability", cat: "Handling" },
      DurabilityLoss: { name: "Durability Loss", cat: "Handling", lowerBetter: true },
      ConsumeAmmoChance: { name: "Ammo Consumption Chance", cat: "Handling", lowerBetter: true },
      ConsumeExtraAmmoChance: { name: "Extra Ammo Consumption", cat: "Handling", lowerBetter: true },
      // --- projectile behaviour ---
      ProjectileAmount: { name: "Projectile Count", cat: "Projectile" },
      ProjectilePenetration: { name: "Penetration", cat: "Projectile" },
      ProjectilePenetrationDamageMultiplier: { name: "Penetration Damage", cat: "Projectile" },
      ProjectileBounce: { name: "Bounces", cat: "Projectile" },
      ProjectileBounciness: { name: "Bounciness", cat: "Projectile" },
      ProjectileMass: { name: "Projectile Mass", cat: "Projectile" },
      ProjectileScale: { name: "Projectile Size", cat: "Projectile" },
      ProjectileDrag: { name: "Projectile Drag", cat: "Projectile" },
      ProjectileTimeScale: { name: "Projectile Time Scale", cat: "Projectile" },
      ProjectileLifeTime: { name: "Projectile Lifetime", cat: "Projectile" },
      ProjectileForce: { name: "Projectile Force", cat: "Projectile" },
      ProjectileKinematicForce: { name: "Projectile Force (Kinematic)", cat: "Projectile" },
      ProjectileKinematicSteerable: { name: "Steerable Projectiles", cat: "Projectile" },
      ProjectileMoveAsLight: { name: "Light-Speed Projectiles", cat: "Projectile" },
      ProjectileMoveAsSpray: { name: "Spray Projectiles", cat: "Projectile" },
      ProjectileBeam: { name: "Beam Projectiles", cat: "Projectile" },
      ProjectileDrunk: { name: "Wobbly Projectiles", cat: "Projectile" },
      KnockbackPower: { name: "Knockback", cat: "Projectile" },
      ProjectileTurnOffBulletHoles: { name: "No Bullet Holes", cat: "Projectile", flag: true },
      ProjectileDisableDamageComponentEffects: { name: "No Impact Effects", cat: "Projectile", flag: true },
      DisableBloodOnHit: { name: "No Blood on Hit", cat: "Projectile", flag: true },
      ShootEffectSoundOnly: { name: "Silent Muzzle Effect", cat: "Projectile", flag: true },
      ImpactEffectSoundOnly: { name: "Silent Impact Effect", cat: "Projectile", flag: true },
      // --- on-hit status your bullets apply (offensive) ---
      ProjectileApplyStun: { name: "Applies Stun", cat: "On-hit" },
      ProjectileApplyFire: { name: "Applies Fire", cat: "On-hit" },
      ProjectileApplyFrost: { name: "Applies Frost", cat: "On-hit" },
      ProjectileApplyPoison: { name: "Applies Poison", cat: "On-hit" },
      ProjectileApplyElectricity: { name: "Applies Electricity", cat: "On-hit" },
      ProjectileApplyPetrification: { name: "Applies Petrification", cat: "On-hit" },
      ProjectileApplyCharm: { name: "Applies Charm", cat: "On-hit" },
      ProjectileApplyBlind: { name: "Applies Blind", cat: "On-hit" },
      ProjectileApplyFear: { name: "Applies Fear", cat: "On-hit" },
      ProjectileApplyRoot: { name: "Applies Root", cat: "On-hit" },
      ProjectileApplyOil: { name: "Applies Oil", cat: "On-hit" },
      ProjectileApplyVoodoo: { name: "Applies Voodoo", cat: "On-hit" },
      ProjectileApplyCrusader: { name: "Applies Crusader", cat: "On-hit" },
      // --- on-hit spawns / elemental effects ---
      ProjectileOnHitNoxiosaCloud: { name: "On Hit: Noxiosa Cloud", cat: "On-hit" },
      ProjectileOnHitAftershock: { name: "On Hit: Aftershock", cat: "On-hit" },
      ProjectileOnHitLava: { name: "On Hit: Lava", cat: "On-hit" },
      ProjectileOnHitWater: { name: "On Hit: Water", cat: "On-hit" },
      ProjectileOnHitOil: { name: "On Hit: Oil", cat: "On-hit" },
      ProjectileOnHitExplosionRPG: { name: "On Hit: Explosion", cat: "On-hit" },
      ProjectileOnHitStormSurge: { name: "On Hit: Storm Surge", cat: "On-hit" },
      ProjectileHolyWater: { name: "Holy Water Rounds", cat: "On-hit" },
      ProjectilePollen: { name: "Pollen Rounds", cat: "On-hit" },
      ProjectileCryoSnakes: { name: "Cryo Snakes", cat: "On-hit" },
      ProjectilePrism: { name: "Prism Rounds", cat: "On-hit" },
      ProjectileVinesprout: { name: "Vinesprout", cat: "On-hit" },
      ProjectileMetamorph: { name: "Metamorph", cat: "On-hit" },
      ProjectileVisualCryoRocket: { name: "Cryo Rocket", cat: "On-hit" },
      // --- player stats (worn gear) ---
      ItemStat_MoveSpeed: { name: "Movement Speed", cat: "Player" },
      ItemStat_JumpPower: { name: "Jump Power", cat: "Player" },
      ItemStat_LootChanceMultiplier: { name: "Loot Chance", cat: "Player" },
      Stat_MaxHealth: { name: "Max Health", cat: "Player" },
      Stat_MovementSpeed: { name: "Movement Speed", cat: "Player" },
      Stat_HealthRegen: { name: "Health Regen", cat: "Player" },
      Stat_CritChance: { name: "Crit Chance", cat: "Player" },
      Stat_GlobalDamageMultiplier: { name: "Global Damage", cat: "Player" },
      Stat_Lifesteal: { name: "Lifesteal", cat: "Player" },
      Stat_Thorns: { name: "Thorns", cat: "Player" },
      Stat_LuckGain: { name: "Luck", cat: "Player" },
      Stat_JumpPower: { name: "Jump Power", cat: "Player" },
      // --- loot / meta ---
      DisableLootMoney: { name: "No Money Drops", cat: "Loot", flag: true },
      DisableLootOrgans: { name: "No Organ Drops", cat: "Loot", flag: true },
    },
  };
})();
