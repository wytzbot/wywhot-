// Adsterra hook. Use the supplied publisher unit for free-user ads.
// The 10-second hint screen is a timed sponsor experience; it is not a
// provider-verified rewarded-ad callback.
function enabled(){return !!process.env.ADSTERRA_AD_CODE}
function show(isPro){return !isPro&&enabled()}
module.exports={enabled,show};
